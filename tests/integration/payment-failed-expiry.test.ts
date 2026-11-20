/**
 * M11 P1-T3 (F06): an online order whose payment attempt FAILED must still expire after the payment window and release
 * its stock, without touching a legitimate retry, an authorized/captured payment, or a gateway it could not read; and a
 * capture that lands after expiry is recorded for a human (orphan capture), never dropped. Gateway = deterministic fake.
 */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { expireUnpaidOrders, RETRY_GRACE_MINUTES } from "@/lib/orders/expire";
import { startOnlinePayment } from "@/lib/payments/checkout";
import { currentPaymentProvider, safePaymentConfig } from "@/lib/payments";
import { applyGatewayPayment } from "@/lib/payments/razorpay-verify";
import { reconcileGateway } from "@/lib/payments/reconcile";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET, TEST_WEBHOOK_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures } from "../support/mock-orders";
import { cleanupInventoryFixtures, createInventoryVariant, customer, movements, variantState } from "../support/inventory";
import { POST as webhookRoute } from "@/app/api/payments/razorpay/webhook/route";

let fake: FakeRazorpay;
const config = () => safePaymentConfig()!;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const tag = Date.now().toString(36);
let seq = 0;

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  fake = new FakeRazorpay().install();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupInventoryFixtures();
  await cleanupFixtures();
  await db.$disconnect();
});

const load = (id: string) =>
  db.order.findUniqueOrThrow({ where: { id }, include: { payments: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } });

/** A real online order (createOrder + gateway order), created `ageMinutes` ago. */
async function placeOnline(stock: number, qty: number, ageMinutes = 120) {
  const t = await createInventoryVariant({ stock });
  const order = await createOrder({ ...customer, paymentMethod: "razorpay", items: [{ variantId: t.variantId, quantity: qty }] });
  expect((await startOnlinePayment(order, order.payments[0].id, currentPaymentProvider()!)).kind).toBe("ready");
  await db.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - ageMinutes * 60_000) } }); // non-status write: test setup only
  const o = await load(order.id);
  return { t, order: o, gw: o.razorpayOrderId! };
}

/** Delivers a signed Razorpay webhook through the real route. */
async function webhook(event: string, entity: { id: string; order_id: string; status: string; amount: number; currency?: string }) {
  const raw = JSON.stringify({ entity: "event", event, payload: { payment: { entity: { currency: "INR", ...entity } } } });
  const signature = crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(raw).digest("hex");
  const res = await webhookRoute(new Request("http://localhost/api/payments/razorpay/webhook", { method: "POST", headers: { "x-razorpay-event-id": `evt_f06_${tag}_${++seq}`, "x-razorpay-signature": signature }, body: raw }));
  return (await res.json()) as { ok: boolean; outcome?: string };
}

/** The customer's attempt fails at the gateway and the signed `payment.failed` webhook reaches us. */
async function failAttempt(gw: string, total: number) {
  const p = fake.addPayment(gw, "failed", { amount: total });
  expect((await webhook("payment.failed", { id: p.id, order_id: gw, status: "failed", amount: total })).outcome).toBe("payment_failed");
  return p;
}

/** A captured gateway payment the expiry sweep cannot see (not registered in the fake): models a capture racing the sweep. */
const unseenCapture = (gw: string, amount: number) => ({ id: `pay_f06late${tag}${String(++seq).padStart(4, "0")}`, orderId: gw, status: "captured", amount, currency: "INR" });

describe("F06: failed online attempts expire and release stock", () => {
  it("reproduction: a failed attempt past the window is cancelled and its stock released, with a full event trail", async () => {
    const { t, order, gw } = await placeOnline(5, 3);
    await failAttempt(gw, order.total);
    expect(await load(order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 3, stockQuantity: 5 });

    const s = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect(s.expired).toBeGreaterThanOrEqual(1);

    const o = await load(order.id);
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ status: "failed", needsReconciliation: false, reconcileReason: "payment_window_expired", providerPaymentId: null });
    expect(o.events.map((e) => [e.fromStatus, e.toStatus, e.fromPaymentStatus, e.toPaymentStatus, e.actorType, e.actorId])).toEqual([
      ["awaiting_payment", "awaiting_payment", "unpaid", "failed", "gateway", "razorpay"],
      ["awaiting_payment", "cancelled", null, null, "system", "expiry"],
    ]);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0, stockQuantity: 5 });
    const mv = await movements(t.variantId);
    expect(mv.filter((m) => m.reason === "release")).toHaveLength(1);
    expect(mv.at(-1)).toMatchObject({ reason: "release", actorType: "system" });
    expect(await findLedgerDrift()).toEqual([]);

    // a second run changes nothing: no double release, no extra event
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 2) });
    expect(await movements(t.variantId)).toHaveLength(mv.length);
    expect((await load(order.id)).events).toHaveLength(2);
  });

  it("keeps a failed order inside the payment window, and a retry there pays it with the stock still held", async () => {
    const { t, order, gw } = await placeOnline(5, 2, 5);
    await failAttempt(gw, order.total);
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.expired).toBe(0);
    expect(await load(order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });

    const retry = fake.addPayment(gw, "captured", { amount: order.total });
    expect((await webhook("payment.captured", { id: retry.id, order_id: gw, status: "captured", amount: order.total })).outcome).toBe("paid");
    const o = await load(order.id);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: retry.id });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2, stockQuantity: 5 });
  });

  it("gives a customer who just failed time to retry, even past the window", async () => {
    const { t, order, gw } = await placeOnline(5, 1);
    await failAttempt(gw, order.total);
    const early = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES - 1) });
    expect(early.expired).toBe(0);
    expect((await load(order.id)).status).toBe("awaiting_payment");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 });
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect((await load(order.id)).status).toBe("cancelled");
  });

  it("marks the order paid when the gateway shows a captured retry nobody told us about", async () => {
    const { t, order, gw } = await placeOnline(5, 2);
    await failAttempt(gw, order.total);
    const retry = fake.addPayment(gw, "captured", { amount: order.total });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect(s.paid).toBeGreaterThanOrEqual(1);
    const o = await load(order.id);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: retry.id });
    expect(o.events.at(-1)).toMatchObject({ fromPaymentStatus: "failed", toPaymentStatus: "paid", actorType: "gateway" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("does not cancel when a retry is authorized (money held, outcome open)", async () => {
    const { t, order, gw } = await placeOnline(5, 2);
    await failAttempt(gw, order.total);
    fake.addPayment(gw, "authorized", { amount: order.total });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect(s.pending).toBeGreaterThanOrEqual(1);
    expect(await load(order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("never cancels a failed order on a gateway answer it could not read", async () => {
    const { t, order, gw } = await placeOnline(5, 2);
    await failAttempt(gw, order.total);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect(s.errors).toBeGreaterThanOrEqual(1);
    expect(await load(order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("never touches an orphan-capture row (captured money waiting for a refund) while expiring its order", async () => {
    const { t, order, gw } = await placeOnline(5, 1);
    await failAttempt(gw, order.total);
    // a capture with the wrong amount: recorded as an orphan, never applied
    const odd = fake.addPayment(gw, "captured", { amount: order.total + 100 });
    expect((await webhook("payment.captured", { id: odd.id, order_id: gw, status: "captured", amount: order.total + 100 })).outcome).toBe("orphan_recorded");
    fake.payments.delete(odd.id); // the gateway later refunds it; it no longer lists as captured
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    const o = await load(order.id);
    expect(o.status).toBe("cancelled");
    const orphan = o.payments.find((p) => p.providerPaymentId === odd.id)!;
    expect(orphan).toMatchObject({ status: "unpaid", needsReconciliation: true, reconcileReason: "amount_mismatch", amount: order.total + 100 });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 });
  });
});

describe("F06: concurrency between expiry, verification and webhooks", () => {
  it("a capture applied while the sweep waits on the gateway wins: order paid, stock held, nothing recorded as orphan", async () => {
    const { t, order, gw } = await placeOnline(5, 1);
    await failAttempt(gw, order.total);
    const gateway = globalThis.fetch;
    const late = unseenCapture(gw, order.total);
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      const res = await gateway(...args); // the sweep's gateway lookup shows only the failed try
      const o = await load(order.id);
      expect((await applyGatewayPayment({ order: o, attempt: o.payments[0], gp: late, expectedOrderId: gw })).kind).toBe("paid");
      return res;
    }));
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    expect(s.expired).toBe(0);
    const o = await load(order.id);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(o.payments).toHaveLength(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 });
  });

  it("a capture verified after expiry is recorded as an orphan capture, never dropped and never re-reserving stock", async () => {
    const { t, order, gw } = await placeOnline(5, 2);
    await failAttempt(gw, order.total);
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) });
    const late = unseenCapture(gw, order.total);
    const o = await load(order.id);
    expect(o.status).toBe("cancelled");
    // the browser's verify (or reconciliation) reaches the shared apply path with the stale snapshot it read earlier
    const r = await applyGatewayPayment({ order: { ...o, paymentStatus: "failed" }, attempt: o.payments[0], gp: late, expectedOrderId: gw });
    expect(r).toMatchObject({ kind: "conflict" });
    const after = await load(order.id);
    expect(after).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(after.payments.find((p) => p.providerPaymentId === late.id)).toMatchObject({ status: "unpaid", amount: order.total, needsReconciliation: true, reconcileReason: "captured_on_cancelled_order" });
    expect(after.payments[0]).toMatchObject({ status: "failed", providerPaymentId: null });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0, stockQuantity: 5 });
  });

  it("racing expiry against a capture (verify path) many times never loses money or stock", async () => {
    for (let i = 0; i < 8; i++) {
      const { t, order, gw } = await placeOnline(3, 1);
      await failAttempt(gw, order.total);
      const late = unseenCapture(gw, order.total);
      const o = await load(order.id);
      await Promise.all([
        expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) }),
        applyGatewayPayment({ order: o, attempt: o.payments[0], gp: late, expectedOrderId: gw }),
      ]);
      await assertConsistent(order.id, t.variantId, late.id);
    }
  });

  it("racing expiry against the captured webhook many times never loses money or stock", async () => {
    for (let i = 0; i < 8; i++) {
      const { t, order, gw } = await placeOnline(3, 1);
      await failAttempt(gw, order.total);
      const late = unseenCapture(gw, order.total);
      const [, wh] = await Promise.all([
        expireUnpaidOrders(config(), { windowMinutes: 60, now: minutesFromNow(RETRY_GRACE_MINUTES + 1) }),
        webhook("payment.captured", { id: late.id, order_id: gw, status: "captured", amount: order.total }),
      ]);
      expect(wh.ok).toBe(true);
      await assertConsistent(order.id, t.variantId, late.id);
    }
  });

  it("two concurrent expiry runs cancel once and release once", async () => {
    const { t, order, gw } = await placeOnline(5, 2);
    await failAttempt(gw, order.total);
    const now = minutesFromNow(RETRY_GRACE_MINUTES + 1);
    const [a, b] = await Promise.all([expireUnpaidOrders(config(), { windowMinutes: 60, now }), expireUnpaidOrders(config(), { windowMinutes: 60, now })]);
    expect(a.errors + b.errors).toBe(0);
    const o = await load(order.id);
    expect(o.status).toBe("cancelled");
    expect(o.events.filter((e) => e.toStatus === "cancelled")).toHaveLength(1);
    expect((await movements(t.variantId)).filter((m) => m.reason === "release")).toHaveLength(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 });
  });
});

describe("F06: late captures after expiry reach reconciliation", () => {
  it("a capture that lands at the gateway after expiry (no webhook, no browser) is found and recorded once", async () => {
    const { t, order, gw } = await placeOnline(5, 1);
    await failAttempt(gw, order.total);
    const expiredAt = minutesFromNow(RETRY_GRACE_MINUTES + 1);
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: expiredAt });
    const late = fake.addPayment(gw, "captured", { amount: order.total }); // e.g. a slow UPI approval

    const first = await reconcileGateway(config(), { now: new Date(expiredAt.getTime() + 11 * 60_000) });
    expect(first.lateCaptures).toBe(1);
    const o = await load(order.id);
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(o.payments.find((p) => p.providerPaymentId === late.id)).toMatchObject({ status: "unpaid", amount: order.total, needsReconciliation: true, reconcileReason: "captured_on_cancelled_order" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 });

    const second = await reconcileGateway(config(), { now: new Date(expiredAt.getTime() + 30 * 60_000) });
    expect(second.lateCaptures).toBe(0);
    expect((await load(order.id)).payments.filter((p) => p.providerPaymentId === late.id)).toHaveLength(1);
  });

  it("stops looking a day after expiry and never re-applies the capture to the cancelled order", async () => {
    const { order, gw } = await placeOnline(5, 1);
    await failAttempt(gw, order.total);
    const expiredAt = minutesFromNow(RETRY_GRACE_MINUTES + 1);
    await expireUnpaidOrders(config(), { windowMinutes: 60, now: expiredAt });
    fake.addPayment(gw, "captured", { amount: order.total });
    const s = await reconcileGateway(config(), { now: new Date(expiredAt.getTime() + 25 * 3600_000) });
    expect(s.lateCaptures).toBe(0);
    expect((await load(order.id)).payments).toHaveLength(1);
  });
});

/** After any interleaving: either paid with the hold kept and no orphan, or cancelled with the hold released once and the capture kept as an orphan. */
async function assertConsistent(orderId: string, variantId: string, capturedId: string) {
  const o = await load(orderId);
  const v = await variantState(variantId);
  const releases = (await movements(variantId)).filter((m) => m.reason === "release");
  const orphan = o.payments.find((p) => p.providerPaymentId === capturedId && p.status === "unpaid");
  if (o.status === "paid") {
    expect(o.paymentStatus).toBe("paid");
    expect(o.payments.filter((p) => p.status === "paid")).toHaveLength(1);
    expect(o.payments[0].providerPaymentId).toBe(capturedId);
    expect(orphan).toBeUndefined();
    expect(v.reserved).toBe(1);
    expect(releases).toHaveLength(0);
  } else {
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(orphan).toMatchObject({ needsReconciliation: true, reconcileReason: "captured_on_cancelled_order", amount: o.total });
    expect(v.reserved).toBe(0);
    expect(releases).toHaveLength(1);
  }
  expect(o.events.filter((e) => e.toStatus === "cancelled" || e.toStatus === "paid")).toHaveLength(1);
}
