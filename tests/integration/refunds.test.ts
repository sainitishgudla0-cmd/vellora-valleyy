/**
 * M10-T4: admin refunds through the real route, ledger, state machine and Postgres, against the deterministic fake gateway.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resolvePaymentConfig } from "@/lib/env/payment-config";
import { auditRefunds, reconcileRefunds, STALE_REFUND_MS } from "@/lib/payments/reconcile";
import { cleanupAdminFixtures, createLegacySession, createTestAdmin } from "../support/admin";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET, TEST_WEBHOOK_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createFixtureOrder, createRazorpayOrderWithAttempt } from "../support/mock-orders";

import { GET, POST } from "@/app/api/admin/orders/[id]/refunds/route";
import { PATCH as patchOrder } from "@/app/api/admin/orders/[id]/route";

let fake: FakeRazorpay;
let owner: Awaited<ReturnType<typeof createTestAdmin>>;
let ops: Awaited<ReturnType<typeof createTestAdmin>>;
let viewer: Awaited<ReturnType<typeof createTestAdmin>>;
let seq = 0;
const tag = Date.now().toString(36);
const key = () => `req-${tag}-${++seq}`;
const config = () => resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET } as unknown as NodeJS.ProcessEnv);

const call = async <T extends (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>(fn: T, id: string, cookie: string | null, body?: unknown) => {
  const res = await fn(new Request("http://localhost/api/admin/orders/x/refunds", { method: body === undefined ? "GET" : "POST", headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const refund = (orderId: string, body: Record<string, unknown> = {}, cookie: string | null = owner.cookie) => call(POST, orderId, cookie, { reason: "Customer returned the goods", requestKey: key(), ...body });
const list = (orderId: string, cookie: string | null = owner.cookie) => call(GET, orderId, cookie);
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: { orderBy: { createdAt: "asc" } } } });
const refundCalls = () => fake.calls.filter((c) => c.startsWith("POST") && c.endsWith("/refund"));

/** A paid online order whose payment is captured at the (fake) gateway. */
async function paidOrder(total = 105000) {
  const f = await createRazorpayOrderWithAttempt({ status: "paid", paymentStatus: "paid", total });
  const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: total });
  await db.payment.update({ where: { id: f.attempt.id }, data: { status: "paid", providerPaymentId: pay.id } });
  await db.order.update({ where: { id: f.order.id }, data: { razorpayPaymentId: pay.id } });
  return { ...f, payment: pay };
}

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeRazorpay().install();
  owner ??= await createTestAdmin("owner");
  ops ??= await createTestAdmin("operations");
  viewer ??= await createTestAdmin("viewer");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("authorisation", () => {
  it("only an owner account may refund: no session 401, operations/viewer/legacy 403, and nothing is refunded", async () => {
    const o = await paidOrder();
    const legacy = await createLegacySession();
    expect((await refund(o.order.id, {}, null)).status).toBe(401);
    for (const c of [ops.cookie, viewer.cookie, legacy.cookie]) expect((await refund(o.order.id, {}, c)).status).toBe(403);
    expect(refundCalls()).toHaveLength(0);
    expect(await db.refund.count({ where: { orderId: o.order.id } })).toBe(0);
  });

  it("any signed-in role can read the ledger, nobody else", async () => {
    const o = await paidOrder();
    expect((await list(o.order.id, null)).status).toBe(401);
    expect((await list(o.order.id, viewer.cookie)).status).toBe(200);
    expect((await list("missing")).status).toBe(404);
  });
});

describe("full and partial refunds", () => {
  it("a full refund by default returns the whole balance, calls the gateway once with our receipt, and marks the payment and order refunded", async () => {
    const o = await paidOrder();
    const r = await refund(o.order.id);
    expect(r.status).toBe(201);
    expect(r.body.refund).toMatchObject({ amountPaise: o.order.total, status: "processed", source: "admin" });
    expect(refundCalls()).toHaveLength(1);
    const row = await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } });
    expect(row).toMatchObject({ amount: o.order.total, status: "processed", requestedBy: owner.user.id, reason: "Customer returned the goods" });
    expect(row.providerRefundId).toMatch(/^rfnd_/);
    expect([...fake.refunds.values()][0]).toMatchObject({ amount: o.order.total, receipt: row.id, payment_id: o.payment.id });
    expect(await load(o.order.id)).toMatchObject({ status: "paid", paymentStatus: "refunded" });
    expect((await load(o.order.id)).payments[0].status).toBe("refunded");
    const view = (await list(o.order.id)).body;
    expect(view.payments[0]).toMatchObject({ refundedPaise: o.order.total, refundablePaise: 0, status: "refunded" });
  });

  it("partial refunds keep the payment paid until they cover it; the balance can never be exceeded", async () => {
    const o = await paidOrder(100000);
    expect((await refund(o.order.id, { amountPaise: 30000 })).status).toBe(201);
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "paid" });
    expect((await list(o.order.id)).body.payments[0]).toMatchObject({ refundedPaise: 30000, refundablePaise: 70000 });
    const over = await refund(o.order.id, { amountPaise: 70001 });
    expect(over).toMatchObject({ status: 409, body: { code: "exceeds_refundable", remainingPaise: 70000 } });
    expect((await refund(o.order.id, { amountPaise: 70000 })).status).toBe(201);
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
    expect(await refund(o.order.id)).toMatchObject({ status: 409, body: { code: "not_refundable" } });
    expect([...fake.refunds.values()].reduce((n, x) => n + x.amount, 0)).toBe(100000);
    expect(await db.refund.count({ where: { orderId: o.order.id, status: "processed" } })).toBe(2);
  });

  it("replaying a request key returns the same refund and never calls the gateway again; a different amount under that key is refused", async () => {
    const o = await paidOrder();
    const k = key();
    const first = await refund(o.order.id, { requestKey: k, amountPaise: 20000 });
    const again = await refund(o.order.id, { requestKey: k, amountPaise: 20000 });
    expect(again).toMatchObject({ status: 200, body: { replayed: true } });
    expect(again.body.refund.id).toBe(first.body.refund.id);
    expect((await refund(o.order.id, { requestKey: k, amountPaise: 30000 })).body.code).toBe("key_reused");
    expect(refundCalls()).toHaveLength(1);
    // replay still works after the payment was fully refunded by a later request
    await refund(o.order.id);
    expect((await refund(o.order.id, { requestKey: k, amountPaise: 20000 })).status).toBe(200);
  });

  it("parallel requests for the whole balance refund it exactly once", async () => {
    const o = await paidOrder();
    const results = await Promise.all(Array.from({ length: 6 }, () => refund(o.order.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(refundCalls()).toHaveLength(1);
    expect(await db.refund.count({ where: { orderId: o.order.id } })).toBe(1);
  });

  it("works after the order was cancelled (cancel, then refund) without changing the order status", async () => {
    const o = await paidOrder();
    await db.order.update({ where: { id: o.order.id }, data: { status: "cancelled" } });
    expect((await refund(o.order.id, { amountPaise: 1000 })).status).toBe(201);
    expect(await load(o.order.id)).toMatchObject({ status: "cancelled", paymentStatus: "paid" });
  });
});

describe("what cannot be refunded", () => {
  it("unknown order 404; unpaid, pay-on-delivery and already hand-marked refunded orders 409; no gateway call is made", async () => {
    expect((await refund("missing")).status).toBe(404);
    const unpaid = await createRazorpayOrderWithAttempt({});
    expect((await refund(unpaid.order.id)).body.code).toBe("not_refundable");
    const cod = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "confirmed", paymentStatus: "paid" });
    await db.payment.create({ data: { orderId: cod.id, provider: "request_only", mode: "request_only", amount: cod.total, status: "paid" } });
    expect((await refund(cod.id)).status).toBe(409);
    const manual = await paidOrder();
    const patched = await patchOrder(new Request("http://localhost/x", { method: "PATCH", headers: { cookie: owner.cookie }, body: JSON.stringify({ paymentStatus: "refunded", reason: "Refunded in the dashboard" }) }), { params: Promise.resolve({ id: manual.order.id }) });
    expect(patched.status).toBe(200);
    expect(await refund(manual.order.id)).toMatchObject({ status: 409, body: { code: "not_refundable" } });
    expect(refundCalls()).toHaveLength(0);
  });

  it("a payment made under the other mode, and a non-Razorpay environment, are refused", async () => {
    const live = await createRazorpayOrderWithAttempt({ mode: "razorpay_live", status: "paid", paymentStatus: "paid" });
    await db.payment.update({ where: { id: live.attempt.id }, data: { status: "paid", providerPaymentId: "pay_livefixture_1" } });
    expect((await refund(live.order.id)).body.code).toBe("not_refundable");
    const o = await paidOrder();
    vi.stubEnv("PAYMENT_MODE", "request_only");
    expect((await refund(o.order.id)).status).toBe(503);
    expect(refundCalls()).toHaveLength(0);
  });

  it("rejects bad input with 422 before touching anything", async () => {
    const o = await paidOrder();
    for (const bad of [{ amountPaise: 0 }, { amountPaise: -5 }, { amountPaise: 10.5 }, { amountPaise: "100" }, { reason: "" }, { reason: "x" }, { requestKey: "short" }, { requestKey: "has spaces in it" }, { extra: true }]) {
      expect((await refund(o.order.id, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await db.refund.count({ where: { orderId: o.order.id } })).toBe(0);
  });
});

describe("gateway outcomes", () => {
  it("a refund the gateway leaves pending stays pending (the order is not refunded yet), and reconciliation settles it", async () => {
    const o = await paidOrder();
    fake.refundBehaviour = "pending";
    const r = await refund(o.order.id);
    expect(r).toMatchObject({ status: 201, body: { refund: { status: "pending" } } });
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "paid" });
    expect((await list(o.order.id)).body.payments[0]).toMatchObject({ refundedPaise: 0, refundablePaise: 0 }); // reserved, not yet returned
    const gw = [...fake.refunds.values()][0];
    gw.status = "processed";
    expect(await reconcileRefunds(config())).toMatchObject({ updated: 1 });
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ status: "processed" });
  });

  it("a definite rejection releases the balance so the refund can be tried again", async () => {
    const o = await paidOrder();
    fake.refundBehaviour = "http400";
    const r = await refund(o.order.id);
    expect(r).toMatchObject({ status: 502, body: { code: "gateway_rejected", refund: { status: "failed" } } });
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ status: "failed", failureCode: "gateway_rejected" });
    fake.refundBehaviour = "ok";
    expect((await refund(o.order.id)).status).toBe(201);
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
  });

  it("an unknown outcome keeps the amount reserved, is never retried blindly, and a lost response is matched by receipt", async () => {
    const o = await paidOrder();
    fake.refundBehaviour = "lostResponse"; // the gateway refunded, the answer never arrived
    const k = key();
    const r = await refund(o.order.id, { requestKey: k });
    expect(r).toMatchObject({ status: 502, body: { code: "gateway_unknown", refund: { status: "pending" } } });
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ status: "pending", providerRefundId: null, failureCode: "outcome_unknown" });
    // the amount is held: a second refund of the balance cannot double it, and the same key is a replay (no new gateway call)
    expect((await refund(o.order.id)).body.code).toBe("fully_refunded");
    expect((await refund(o.order.id, { requestKey: k })).body).toMatchObject({ replayed: true });
    expect(refundCalls()).toHaveLength(1);
    expect(await reconcileRefunds(config())).toMatchObject({ checked: 1, updated: 1 });
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ status: "processed", providerRefundId: expect.stringMatching(/^rfnd_/) });
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
    expect(await db.refund.count({ where: { orderId: o.order.id } })).toBe(1);
  });

  it("an unknown outcome where the gateway never created the refund is released only after the grace period", async () => {
    const o = await paidOrder();
    fake.refundBehaviour = "timeout";
    const r = await refund(o.order.id);
    expect(r.body.code).toBe("gateway_unknown");
    expect(await reconcileRefunds(config())).toMatchObject({ checked: 1, failed: 0 });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).status).toBe("pending");
    const later = new Date(Date.now() + STALE_REFUND_MS + 60_000);
    expect(await reconcileRefunds(config(), { now: later })).toMatchObject({ failed: 1 });
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ status: "failed", failureCode: "never_created_at_gateway" });
    fake.refundBehaviour = "ok";
    expect((await refund(o.order.id)).status).toBe(201);
  });

  it("a gateway that answers a different amount is treated as unusable, not as success", async () => {
    const o = await paidOrder();
    const original = fake.addRefund.bind(fake);
    fake.addRefund = (pid, amount, status, over) => original(pid, amount + 1, status, over);
    const r = await refund(o.order.id);
    expect(r.status).toBe(502);
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "paid" });
  });
});

describe("orphan captures", () => {
  it("money captured for a cancelled order can be refunded; the order itself is left alone", async () => {
    const f = await createRazorpayOrderWithAttempt({ status: "cancelled", paymentStatus: "failed" });
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total });
    const orphan = await db.payment.create({ data: { orderId: f.order.id, provider: "razorpay", mode: "razorpay_test", providerOrderId: f.providerOrderId, providerPaymentId: pay.id, amount: f.order.total, status: "unpaid", needsReconciliation: true, reconcileReason: "captured_on_cancelled_order" } });
    expect((await refund(f.order.id)).status).toBe(201);
    expect(await load(f.order.id)).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({ status: "refunded", needsReconciliation: false });
    expect(await db.orderEvent.count({ where: { orderId: f.order.id } })).toBe(0);
  });

  it("with a paid payment and a duplicate capture, the paid one is the default and the duplicate is chosen by id", async () => {
    const o = await paidOrder(50000);
    const dupPay = fake.addPayment(o.providerOrderId!, "captured", { amount: 50000 });
    const dup = await db.payment.create({ data: { orderId: o.order.id, provider: "razorpay", mode: "razorpay_test", providerOrderId: o.providerOrderId, providerPaymentId: dupPay.id, amount: 50000, status: "unpaid", needsReconciliation: true, reconcileReason: "duplicate_capture" } });
    const r = await refund(o.order.id, { paymentId: dup.id });
    expect(r.status).toBe(201);
    expect(await db.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } })).toMatchObject({ paymentId: dup.id });
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "paid" }); // the real payment is untouched
    expect((await refund(o.order.id)).status).toBe(201); // default target: the paid one
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
  });
});

describe("audit", () => {
  it("every attempt is audited with ids and codes only: never the reason text", async () => {
    const o = await paidOrder();
    await db.auditLog.deleteMany({});
    await refund(o.order.id, { reason: "SECRET-REASON-TEXT customer called" });
    await refund(o.order.id, { reason: "SECRET-REASON-TEXT again", amountPaise: 1 }); // rejected: nothing left
    const rows = await db.auditLog.findMany({ where: { action: "order.refund" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.outcome)).toEqual(["success", "rejected"]);
    expect(JSON.stringify(rows)).not.toContain("SECRET-REASON-TEXT");
    expect(rows[0]).toMatchObject({ targetType: "order", targetId: o.order.id });
  });
});

describe("refund audit against the gateway", () => {
  it("adopts a refund made in the Razorpay dashboard while webhooks were down, and settles the order", async () => {
    const o = await paidOrder();
    fake.addRefund(o.payment.id, o.order.total, "processed");
    expect(await auditRefunds(config())).toMatchObject({ errors: 0 });
    expect(await db.refund.count({ where: { orderId: o.order.id, source: "gateway" } })).toBe(1);
    expect(await load(o.order.id)).toMatchObject({ paymentStatus: "refunded" });
    expect((await auditRefunds(config())).adopted).toBe(0); // idempotent
    expect(await db.refund.count({ where: { orderId: o.order.id } })).toBe(1);
  });
});
