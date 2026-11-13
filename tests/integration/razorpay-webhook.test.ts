/**
 * M10-T1/T2/T5: the signed Razorpay webhook through the real route, state machine and Postgres. The gateway is the
 * deterministic fake (any call to another host throws); webhook handling itself makes no gateway call.
 */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET, TEST_WEBHOOK_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createRazorpayOrderWithAttempt } from "../support/mock-orders";

import { POST as webhookRoute } from "@/app/api/payments/razorpay/webhook/route";

let seq = 0;
const tag = Date.now().toString(36);
const eid = () => `evt_${tag}_${++seq}`;
const sign = (raw: string, secret = TEST_WEBHOOK_SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("hex");

interface Delivery { event: string; payload: Record<string, unknown>; eventId?: string | null; secret?: string; signature?: string | null; raw?: string }
async function deliver(d: Delivery) {
  const raw = d.raw ?? JSON.stringify({ entity: "event", event: d.event, payload: d.payload });
  const headers: Record<string, string> = {};
  if (d.eventId !== null) headers["x-razorpay-event-id"] = d.eventId ?? eid();
  if (d.signature !== null) headers["x-razorpay-signature"] = d.signature ?? sign(raw, d.secret);
  const res = await webhookRoute(new Request("http://localhost/api/payments/razorpay/webhook", { method: "POST", headers, body: raw }));
  return { status: res.status, body: (await res.json()) as Record<string, any>, eventId: headers["x-razorpay-event-id"] };
}
const payEntity = (orderId: string | null, paymentId: string, amount: number, status = "captured", currency = "INR") => ({ payment: { entity: { id: paymentId, order_id: orderId, status, amount, currency } } });
const refundEntity = (paymentId: string, refundId: string, amount: number, status = "processed", receipt: string | null = null) => ({ refund: { entity: { id: refundId, payment_id: paymentId, amount, currency: "INR", status, receipt } } });
let pseq = 0;
const payId = () => `pay_wh${tag}${String(++pseq).padStart(4, "0")}`;
const refId = () => `rfnd_wh${tag}${String(++pseq).padStart(4, "0")}`;
const captured = (f: { providerOrderId: string | null; order: { total: number } }, id = payId(), over: { amount?: number; currency?: string } = {}) =>
  ({ event: "payment.captured", payload: payEntity(f.providerOrderId, id, over.amount ?? f.order.total, "captured", over.currency ?? "INR"), paymentId: id });
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: { orderBy: { createdAt: "asc" } } } });
const orderEvents = (orderId: string) => db.orderEvent.count({ where: { orderId } });

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  new FakeRazorpay().install(); // blocks any call to another host: webhook handling makes none
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.webhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${tag}` } } });
  await cleanupFixtures();
  await db.$disconnect();
});

describe("authentication", () => {
  it("a forged, unsigned, wrongly signed or re-serialised webhook is rejected and changes nothing", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    const raw = JSON.stringify({ event: c.event, payload: c.payload });
    const id = eid();
    for (const d of [
      { signature: null },
      { signature: "" },
      { signature: "0".repeat(64) },
      { secret: "another_webhook_secret_value" },
      { signature: sign(raw, TEST_KEY_SECRET) }, // signed with the API key secret, not the webhook secret
      { raw: JSON.stringify(JSON.parse(raw), null, 2), signature: sign(raw) }, // same JSON, different bytes
    ]) {
      const r = await deliver({ event: c.event, payload: c.payload, eventId: id, ...d });
      expect(r.status, JSON.stringify(Object.keys(d))).toBe(400);
    }
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", razorpayPaymentId: null });
    expect(await orderEvents(f.order.id)).toBe(0);
    expect(await db.webhookEvent.count({ where: { eventId: id } })).toBe(0);
    expect(await db.payment.count({ where: { providerPaymentId: c.paymentId } })).toBe(0);
  });

  it("needs an event id; a signed but malformed body is a 400 that records nothing", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload, eventId: null })).status).toBe(400);
    const junk = "not json";
    expect((await deliver({ event: "x", payload: {}, raw: junk })).status).toBe(400);
    const noPayload = JSON.stringify({ event: "payment.captured" });
    expect((await deliver({ event: "x", payload: {}, raw: noPayload })).status).toBe(400);
    expect((await load(f.order.id)).paymentStatus).toBe("unpaid");
  });

  it("is 503 when no webhook secret is configured, and never acts", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload })).status).toBe(503);
    expect((await load(f.order.id)).paymentStatus).toBe("unpaid");
  });

  it("is 503 outside a Razorpay mode and 413 for an oversized body", async () => {
    expect((await deliver({ event: "x", payload: {}, raw: "x".repeat(300_000) })).status).toBe(413);
    vi.stubEnv("PAYMENT_MODE", "request_only");
    expect((await deliver({ event: "payment.captured", payload: {} })).status).toBe(503);
  });
});

describe("payment.captured / order.paid", () => {
  it("marks the order paid through the state machine, once, however often it is delivered", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    const first = await deliver({ event: c.event, payload: c.payload });
    expect(first).toMatchObject({ status: 200, body: { ok: true, result: "processed", outcome: "paid" } });
    const o = await load(f.order.id);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: c.paymentId });
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: c.paymentId, needsReconciliation: false });
    expect(await db.orderEvent.findFirst({ where: { orderId: o.id } })).toMatchObject({ actorType: "gateway", toStatus: "paid", toPaymentStatus: "paid" });
    // same event id again: a duplicate, nothing re-applied
    const dup = await deliver({ event: c.event, payload: c.payload, eventId: first.eventId });
    expect(dup.body).toMatchObject({ ok: true, result: "duplicate", outcome: "paid" });
    // a different event for the same payment (order.paid after payment.captured): already paid
    const second = await deliver({ event: "order.paid", payload: { ...c.payload, order: { entity: { id: f.providerOrderId } } } });
    expect(second.body).toMatchObject({ result: "processed", outcome: "already_paid" });
    expect(await orderEvents(o.id)).toBe(1);
    expect(await db.webhookEvent.count({ where: { eventId: { in: [first.eventId, second.eventId] } } })).toBe(2);
  });

  it("parallel deliveries of the same event apply it exactly once", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    const id = eid();
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver({ event: c.event, payload: c.payload, eventId: id })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await orderEvents(f.order.id)).toBe(1);
    expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
    expect((await load(f.order.id)).paymentStatus).toBe("paid");
    expect(await db.webhookEvent.count({ where: { eventId: id } })).toBe(1);
  });

  it("an amount or currency that differs from the order is never applied; the money is recorded for a human", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const wrongAmount = captured(f, payId(), { amount: f.order.total - 100 });
    expect((await deliver({ event: wrongAmount.event, payload: wrongAmount.payload })).body).toMatchObject({ outcome: "orphan_recorded" });
    const wrongCurrency = captured(f, payId(), { currency: "USD" });
    await deliver({ event: wrongCurrency.event, payload: wrongCurrency.payload });
    const o = await load(f.order.id);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", razorpayPaymentId: null });
    expect(await orderEvents(o.id)).toBe(0);
    expect(o.payments[0]).toMatchObject({ status: "unpaid", providerPaymentId: null });
    const orphan = o.payments.find((p) => p.providerPaymentId === wrongAmount.paymentId);
    expect(orphan).toMatchObject({ status: "unpaid", amount: f.order.total - 100, needsReconciliation: true, reconcileReason: "amount_mismatch" });
    // redelivery under a new event id does not duplicate the record
    await deliver({ event: wrongAmount.event, payload: wrongAmount.payload });
    expect(await db.payment.count({ where: { providerPaymentId: wrongAmount.paymentId } })).toBe(1);
  });

  it("money arriving for an order that was cancelled is recorded as an orphan capture, and the order stays cancelled", async () => {
    const f = await createRazorpayOrderWithAttempt({ status: "cancelled", paymentStatus: "failed" });
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload })).body.outcome).toBe("orphan_recorded");
    expect(await load(f.order.id)).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect((await load(f.order.id)).payments.find((p) => p.providerPaymentId === c.paymentId)).toMatchObject({ reconcileReason: "captured_on_cancelled_order", amount: f.order.total, status: "unpaid" });
    expect(await orderEvents(f.order.id)).toBe(0);
  });

  it("a second captured payment for an already paid order is recorded as a duplicate capture", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const first = captured(f);
    await deliver({ event: first.event, payload: first.payload });
    const second = captured(f);
    expect((await deliver({ event: second.event, payload: second.payload })).body.outcome).toBe("orphan_recorded");
    const o = await load(f.order.id);
    expect(o).toMatchObject({ status: "paid", razorpayPaymentId: first.paymentId });
    expect(o.payments.find((p) => p.providerPaymentId === second.paymentId)).toMatchObject({ reconcileReason: "duplicate_capture", status: "unpaid" });
    expect(await orderEvents(o.id)).toBe(1);
  });

  it("a payment for an unknown gateway order, or only authorized, changes nothing", async () => {
    const unknown = await deliver({ event: "payment.captured", payload: payEntity("order_nobody", payId(), 1000) });
    expect(unknown.body).toMatchObject({ result: "ignored", outcome: "unknown_order" });
    const f = await createRazorpayOrderWithAttempt({});
    const auth = await deliver({ event: "payment.captured", payload: payEntity(f.providerOrderId, payId(), f.order.total, "authorized") });
    expect(auth.body.outcome).toBe("pending");
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
  });

  it("an order created under another mode is never touched", async () => {
    const f = await createRazorpayOrderWithAttempt({ mode: "razorpay_live" });
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload })).body.outcome).toBe("mode_mismatch");
    expect((await load(f.order.id)).paymentStatus).toBe("unpaid");
  });

  it("a legacy order with no recorded mode is never classified or paid", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    await db.order.update({ where: { id: f.order.id }, data: { paymentMode: null } });
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload })).body.outcome).toBe("legacy_unclassified");
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
  });
});

describe("out of order and failure events", () => {
  it("payment.failed marks the attempt failed without cancelling; a later capture still pays the order", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const failedId = payId();
    expect((await deliver({ event: "payment.failed", payload: payEntity(f.providerOrderId, failedId, f.order.total, "failed") })).body.outcome).toBe("payment_failed");
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });
    const c = captured(f);
    expect((await deliver({ event: c.event, payload: c.payload })).body.outcome).toBe("paid");
    expect(await load(f.order.id)).toMatchObject({ status: "paid", paymentStatus: "paid" });
  });

  it("a failure event that arrives after the success never undoes it", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    await deliver({ event: c.event, payload: c.payload });
    const late = await deliver({ event: "payment.failed", payload: payEntity(f.providerOrderId, payId(), f.order.total, "failed") });
    expect(late.body.outcome).toBe("failed_ignored");
    expect(await load(f.order.id)).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: c.paymentId });
    expect(await orderEvents(f.order.id)).toBe(1);
  });

  it("unsupported events are acknowledged and ignored", async () => {
    const r = await deliver({ event: "payment.authorized", payload: payEntity("order_x", payId(), 100, "authorized") });
    expect(r).toMatchObject({ status: 200, body: { result: "ignored", outcome: "unsupported_event" } });
  });
});

describe("a processing failure is retried by the gateway", () => {
  it("answers 500 and marks the event failed; redelivering the same event id then succeeds exactly once", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    const id = eid();
    const name = `vv_wh_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "OrderEvent" FOR EACH ROW WHEN (NEW."orderId" = '${f.order.id}') EXECUTE FUNCTION ${name}()`);
    try {
      expect((await deliver({ event: c.event, payload: c.payload, eventId: id })).status).toBe(500);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "OrderEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    expect(await db.webhookEvent.findFirstOrThrow({ where: { eventId: id } })).toMatchObject({ status: "failed", attempts: 1 });
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" }); // atomic: nothing half-applied
    const retry = await deliver({ event: c.event, payload: c.payload, eventId: id });
    expect(retry.body).toMatchObject({ result: "processed", outcome: "paid" });
    expect(await db.webhookEvent.findFirstOrThrow({ where: { eventId: id } })).toMatchObject({ status: "processed", attempts: 2 });
    expect(await orderEvents(f.order.id)).toBe(1);
  });
});

describe("refund events", () => {
  async function paidOrder() {
    const f = await createRazorpayOrderWithAttempt({});
    const c = captured(f);
    await deliver({ event: c.event, payload: c.payload });
    return { ...f, paymentId: c.paymentId };
  }

  it("a full refund made in the Razorpay dashboard is adopted into the ledger and moves the payment to refunded", async () => {
    const f = await paidOrder();
    const rid = refId();
    const r = await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, rid, f.order.total) });
    expect(r.body.outcome).toBe("refund_recorded");
    expect(await db.refund.findFirstOrThrow({ where: { providerRefundId: rid } })).toMatchObject({ amount: f.order.total, status: "processed", source: "gateway", orderId: f.order.id });
    expect(await load(f.order.id)).toMatchObject({ status: "paid", paymentStatus: "refunded" });
    expect((await load(f.order.id)).payments[0].status).toBe("refunded");
    expect(await db.orderEvent.findFirst({ where: { orderId: f.order.id, toPaymentStatus: "refunded" } })).toMatchObject({ actorType: "gateway", fromPaymentStatus: "paid" });
    // redelivery under another event id, and a late refund.created, change nothing
    await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, rid, f.order.total) });
    await deliver({ event: "refund.created", payload: refundEntity(f.paymentId, rid, f.order.total, "pending") });
    expect(await db.refund.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.refund.findFirstOrThrow({ where: { providerRefundId: rid } })).toMatchObject({ status: "processed" });
    expect(await orderEvents(f.order.id)).toBe(2);
  });

  it("partial refunds accumulate in the ledger; the payment becomes refunded only when they cover it all", async () => {
    const f = await paidOrder();
    const part = Math.floor(f.order.total / 3);
    await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, refId(), part) });
    expect(await load(f.order.id)).toMatchObject({ paymentStatus: "paid" });
    await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, refId(), f.order.total - part) });
    expect(await load(f.order.id)).toMatchObject({ paymentStatus: "refunded" });
    const rows = await db.refund.findMany({ where: { orderId: f.order.id } });
    expect(rows.reduce((n, r) => n + r.amount, 0)).toBe(f.order.total);
  });

  it("a pending refund holds nothing until processed; refund.created then processed advances once; a failed refund stays failed", async () => {
    const f = await paidOrder();
    const rid = refId();
    await deliver({ event: "refund.created", payload: refundEntity(f.paymentId, rid, f.order.total, "pending") });
    expect(await load(f.order.id)).toMatchObject({ paymentStatus: "paid" });
    await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, rid, f.order.total) });
    expect(await load(f.order.id)).toMatchObject({ paymentStatus: "refunded" });
    const g = await paidOrder();
    const bad = refId();
    await deliver({ event: "refund.failed", payload: refundEntity(g.paymentId, bad, g.order.total, "failed") });
    expect(await db.refund.findFirstOrThrow({ where: { providerRefundId: bad } })).toMatchObject({ status: "failed" });
    expect(await load(g.order.id)).toMatchObject({ paymentStatus: "paid" });
  });

  it("a refund for a payment we have not recorded is acknowledged and ignored", async () => {
    const r = await deliver({ event: "refund.processed", payload: refundEntity("pay_never_seen", refId(), 500) });
    expect(r.body).toMatchObject({ result: "ignored", outcome: "unknown_payment" });
  });

  it("a refund event whose amount differs from the ledger row it matches is flagged, not applied", async () => {
    const f = await paidOrder();
    const attempt = await db.payment.findFirstOrThrow({ where: { providerPaymentId: f.paymentId } });
    const row = await db.refund.create({ data: { orderId: f.order.id, paymentId: attempt.id, amount: 1000, reason: "Customer request", requestKey: `k-${tag}-${seq}`, providerRefundId: "rfnd_known" } });
    const r = await deliver({ event: "refund.processed", payload: refundEntity(f.paymentId, "rfnd_known", 2000) });
    expect(r.body.outcome).toBe("ledger_mismatch");
    expect(await db.refund.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ amount: 1000, status: "pending" });
  });
});
