/** Recovery of unknown gateway outcomes (ADR 0009) against real Postgres and the fake gateway. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resolvePaymentConfig } from "@/lib/env/payment-config";
import { reconcilePendingPayments } from "@/lib/payments/reconcile";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createRazorpayOrderWithAttempt } from "../support/mock-orders";

let fake: FakeRazorpay;
const config = () => resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET } as unknown as NodeJS.ProcessEnv);
const flag = (id: string, reason = "x") => db.payment.update({ where: { id }, data: { needsReconciliation: true, reconcileReason: reason } });
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
const tomorrow = new Date(Date.now() + 24 * 3600_000);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeRazorpay().install();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupFixtures();
  await db.$disconnect();
});

describe("reconcilePendingPayments", () => {
  it("completes an authorized-then-captured payment through the state machine (once)", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    await flag(f.attempt.id, "gateway_authorized");
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total });
    const s = await reconcilePendingPayments(config());
    expect(s.paid).toBeGreaterThanOrEqual(1);
    const o = await load(f.order.id);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: pay.id });
    expect(o.payments[0]).toMatchObject({ status: "paid", needsReconciliation: false });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(1);
    await reconcilePendingPayments(config());
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(1); // idempotent: nothing flagged remains
  });

  it("leaves an authorized payment pending, and clears the flag when nothing is settling", async () => {
    const auth = await createRazorpayOrderWithAttempt({});
    const idle = await createRazorpayOrderWithAttempt({});
    await flag(auth.attempt.id);
    await flag(idle.attempt.id);
    fake.addPayment(auth.providerOrderId!, "authorized", { amount: auth.order.total });
    await reconcilePendingPayments(config());
    expect((await load(auth.order.id)).payments[0]).toMatchObject({ status: "unpaid", needsReconciliation: true });
    expect((await load(auth.order.id)).paymentStatus).toBe("unpaid");
    expect((await load(idle.order.id)).payments[0]).toMatchObject({ status: "unpaid", needsReconciliation: false });
  });

  it("a captured payment whose amount differs is never applied", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    await flag(f.attempt.id);
    fake.addPayment(f.providerOrderId!, "captured", { amount: 1 });
    await reconcilePendingPayments(config());
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
  });

  it("a lost create response: finds the gateway order by receipt and attaches the reference", async () => {
    const f = await createRazorpayOrderWithAttempt({ providerOrderId: null });
    await flag(f.attempt.id, "create_outcome_unknown");
    fake.orders.set("order_found1", { id: "order_found1", amount: f.order.total, currency: "INR", receipt: f.order.number, status: "created" });
    const s = await reconcilePendingPayments(config());
    expect(s.attached).toBeGreaterThanOrEqual(1);
    const o = await load(f.order.id);
    expect(o.razorpayOrderId).toBe("order_found1");
    expect(o.payments[0].providerOrderId).toBe("order_found1");
    expect(o.status).toBe("awaiting_payment");
  });

  it("no gateway order yet and recent → left alone; stale → cancelled through the state machine", async () => {
    const f = await createRazorpayOrderWithAttempt({ providerOrderId: null });
    await flag(f.attempt.id, "create_outcome_unknown");
    await reconcilePendingPayments(config());
    expect((await load(f.order.id)).status).toBe("awaiting_payment");
    const s = await reconcilePendingPayments(config(), { now: tomorrow });
    expect(s.cancelled).toBeGreaterThanOrEqual(1);
    const o = await load(f.order.id);
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("an unreachable gateway cancels nothing and pays nothing", async () => {
    const f = await createRazorpayOrderWithAttempt({ providerOrderId: null });
    await flag(f.attempt.id);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    const s = await reconcilePendingPayments(config(), { now: tomorrow });
    expect(s.errors).toBeGreaterThanOrEqual(1);
    expect(await load(f.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
  });

  it("ignores attempts from other modes and does nothing outside razorpay modes", async () => {
    const live = await createRazorpayOrderWithAttempt({ mode: "razorpay_live" });
    await flag(live.attempt.id);
    fake.addPayment(live.providerOrderId!, "captured", { amount: live.order.total });
    await reconcilePendingPayments(config());
    expect((await load(live.order.id)).status).toBe("awaiting_payment");
    const none = await reconcilePendingPayments(resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "mock" } as unknown as NodeJS.ProcessEnv));
    expect(none.checked).toBe(0);
  });
});
