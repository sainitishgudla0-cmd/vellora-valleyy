/**
 * M2-T5 end-to-end backend flows through the real route handlers and a real (disposable) Postgres.
 * Razorpay is replaced by a deterministic fake; any other network call throws. Covers scenarios A, B, C, H.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { mockProof } from "@/lib/payments/providers/mock";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as verifyRoute } from "@/app/api/payments/razorpay/verify/route";
import { POST as mockConfirmRoute } from "@/app/api/payments/mock/confirm/route";

const CONFIRM_KEY = "test-only-mock-confirm-key-0123456789";
let fake: FakeRazorpay;
let variantId: string;
const created: string[] = [];

const customer = {
  customerName: "SMOKE TEST Flow", email: "smoke.flow@example.com", phone: "9876543210", addressLine1: "1 Test Street",
  city: "Anantapur", state: "Andhra Pradesh", pincode: "515001",
};
const call = async (route: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) => {
  const res = await route(new Request("http://localhost/api", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const place = async (paymentMethod: "cod" | "razorpay", extra: Record<string, unknown> = {}) => {
  const r = await call(createOrderRoute, { ...customer, paymentMethod, items: [{ variantId, quantity: 2 }], ...extra });
  if (r.body.order?.number) created.push(r.body.order.number);
  return r;
};
const byNumber = (n: string) => db.order.findUniqueOrThrow({ where: { number: n }, include: { payments: true } });
const setMode = (mode: string) => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", mode);
  if (mode === "razorpay_test") {
    vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
    vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  }
};

beforeEach(async () => {
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  rate.rateLimit.mockResolvedValue(true);
  fake = new FakeRazorpay().install();
  variantId ??= (await db.variant.findFirstOrThrow({ where: { inStock: true, product: { active: true } } })).id;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.order.deleteMany({ where: { customerName: "SMOKE TEST Flow" } });
  await cleanupFixtures();
  await db.$disconnect();
});

describe("A. guest checkout, request-only (pay on delivery)", () => {
  it("creates a pending, unpaid order with a request_only attempt and the unchanged response shape", async () => {
    setMode("request_only");
    const r = await place("cod");
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(["order"]);
    expect(Object.keys(r.body.order).sort()).toEqual(["number", "token", "total"]);
    const o = await byNumber(r.body.order.number);
    expect(o).toMatchObject({ status: "pending_confirmation", paymentStatus: "unpaid", paymentMethod: "cod", paymentMode: "request_only", total: r.body.order.total });
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ provider: "request_only", mode: "request_only", status: "unpaid", amount: o.total, currency: "INR", providerOrderId: null });
    expect(fake.calls).toEqual([]);
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("COD stays request_only under every configured mode (never mock, never gateway)", async () => {
    for (const mode of ["mock", "razorpay_test"]) {
      setMode(mode);
      const o = await byNumber((await place("cod")).body.order.number);
      expect(o).toMatchObject({ paymentMode: "request_only", status: "pending_confirmation" });
      expect(o.payments[0].provider).toBe("request_only");
    }
    expect(fake.calls).toEqual([]);
  });

  it("totals are computed from the database, ignoring client prices, providers and modes", async () => {
    setMode("request_only");
    const v = await db.variant.findUniqueOrThrow({ where: { id: variantId } });
    const r = await place("cod", { price: 1, total: 1, subtotal: 1, provider: "razorpay", paymentMode: "razorpay_live", paymentStatus: "paid", status: "paid" });
    expect(r.status).toBe(201);
    const o = await byNumber(r.body.order.number);
    expect(o.subtotal).toBe(v.price * 2);
    expect(o).toMatchObject({ paymentMode: "request_only", status: "pending_confirmation", paymentStatus: "unpaid" });
  });

  it("online payment is refused (no order created) when the mode is request_only", async () => {
    setMode("request_only");
    const before = await db.order.count({ where: { customerName: "SMOKE TEST Flow" } });
    const r = await place("razorpay");
    expect(r.status).toBe(400);
    expect(await db.order.count({ where: { customerName: "SMOKE TEST Flow" } })).toBe(before);
  });
});

describe("B. mock checkout through the real API", () => {
  beforeEach(() => {
    setMode("mock");
    vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", CONFIRM_KEY);
  });

  it("creates a mock order and attempt with explicitly simulated metadata and no secrets", async () => {
    const r = await place("razorpay");
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ provider: "mock", mock: true, label: "MOCK — no money moved", currency: "INR", amount: r.body.order.total });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(CONFIRM_KEY);
    expect(r.body.payment).not.toHaveProperty("signature");
    expect(r.body.payment).not.toHaveProperty("keyId");
    const o = await byNumber(r.body.order.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paymentMode: "mock", razorpayOrderId: null });
    expect(o.payments[0]).toMatchObject({ provider: "mock", mode: "mock", providerOrderId: r.body.payment.orderId, status: "unpaid" });
    expect(fake.calls).toEqual([]);
  });

  it("order → attempt → authorised confirmation → paid mock order (and not real revenue)", async () => {
    const r = await place("razorpay");
    const proof = mockProof(r.body.payment.orderId);
    const body = { orderNumber: r.body.order.number, token: r.body.order.token, providerOrderId: proof.providerOrderId, providerPaymentId: proof.providerPaymentId, signature: proof.signature };
    expect((await call(mockConfirmRoute, body)).status).toBe(401); // no key
    expect((await byNumber(r.body.order.number)).status).toBe("awaiting_payment");
    const ok = await call(mockConfirmRoute, body, { "x-mock-confirm-key": CONFIRM_KEY });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, mock: true } });
    const o = await byNumber(r.body.order.number);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", paymentMode: "mock", razorpayPaymentId: null });
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: proof.providerPaymentId });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(1);
    expect((await call(mockConfirmRoute, body, { "x-mock-confirm-key": CONFIRM_KEY })).body.alreadyConfirmed).toBe(true);
  });

  it("the Razorpay verify endpoint rejects a mock order, even with a plausible signature", async () => {
    setMode("razorpay_test");
    const r = await (async () => { setMode("mock"); return place("razorpay"); })();
    setMode("razorpay_test");
    const gw = r.body.payment.orderId as string;
    const res = await call(verifyRoute, { orderNumber: r.body.order.number, token: r.body.order.token, razorpay_order_id: gw, razorpay_payment_id: "pay_x", razorpay_signature: fake.signature(gw, "pay_x") });
    expect(res.status).toBe(404); // mock orders carry no Razorpay order reference
    expect((await byNumber(r.body.order.number)).status).toBe("awaiting_payment");
  });
});

describe("C. Razorpay test checkout and verified capture", () => {
  beforeEach(() => setMode("razorpay_test"));

  it("stores the gateway order + attempt and returns the unchanged checkout payload", async () => {
    const r = await place("razorpay");
    expect(r.status).toBe(201);
    expect(r.body.payment).toEqual({ provider: "razorpay", keyId: TEST_KEY_ID, orderId: expect.stringMatching(/^order_fake/), amount: r.body.order.total, currency: "INR" });
    expect(JSON.stringify(r.body)).not.toContain(TEST_KEY_SECRET);
    const o = await byNumber(r.body.order.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paymentMode: "razorpay_test", razorpayOrderId: r.body.payment.orderId });
    expect(o.payments[0]).toMatchObject({ provider: "razorpay", mode: "razorpay_test", providerOrderId: r.body.payment.orderId, amount: o.total, status: "unpaid", needsReconciliation: false });
    expect(fake.orders.get(r.body.payment.orderId)).toMatchObject({ amount: o.total, currency: "INR", receipt: o.number });
  });

  it("captured payment + valid signature → paid order, paid attempt, one gateway event", async () => {
    const r = await place("razorpay");
    const gw = r.body.payment.orderId;
    const pay = fake.addPayment(gw, "captured");
    const v = await call(verifyRoute, { orderNumber: r.body.order.number, token: r.body.order.token, razorpay_order_id: gw, razorpay_payment_id: pay.id, razorpay_signature: fake.signature(gw, pay.id) });
    expect(v).toMatchObject({ status: 200, body: { ok: true } });
    const o = await byNumber(r.body.order.number);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: pay.id });
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: pay.id });
    const ev = await db.orderEvent.findMany({ where: { orderId: o.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "gateway", actorId: "razorpay", fromStatus: "awaiting_payment", toStatus: "paid", fromPaymentStatus: "unpaid", toPaymentStatus: "paid" });
  });

  it("two simultaneous checkout submissions create two independent orders and attempts", async () => {
    const [a, b] = await Promise.all([place("razorpay"), place("razorpay")]);
    expect(a.body.order.number).not.toBe(b.body.order.number);
    expect(a.body.payment.orderId).not.toBe(b.body.payment.orderId);
    const pay = fake.addPayment(a.body.payment.orderId, "captured");
    await call(verifyRoute, { orderNumber: a.body.order.number, token: a.body.order.token, razorpay_order_id: a.body.payment.orderId, razorpay_payment_id: pay.id, razorpay_signature: fake.signature(a.body.payment.orderId, pay.id) });
    expect((await byNumber(a.body.order.number)).status).toBe("paid");
    expect((await byNumber(b.body.order.number)).status).toBe("awaiting_payment");
  });
});

describe("H. gateway failures during checkout", () => {
  beforeEach(() => {
    setMode("razorpay_test");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(["timeout", "http500", "http429", "lostResponse"] as const)("%s: ambiguous — the order is kept awaiting payment, flagged for reconciliation, never cancelled or failed", async (behaviour) => {
    fake.createBehaviour = behaviour;
    const r = await place("razorpay");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("no money has been taken");
    expect(r.body.orderNumber).toMatch(/^VV-/);
    const o = await db.order.findUniqueOrThrow({ where: { number: r.body.orderNumber }, include: { payments: true } });
    created.push(o.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", razorpayOrderId: null });
    expect(o.payments[0]).toMatchObject({ status: "unpaid", providerOrderId: null, needsReconciliation: true, reconcileReason: "create_outcome_unknown" });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });

  it.each(["http400", "wrongAmount", "wrongCurrency", "badBody"] as const)("%s: definite failure — order cancelled and attempt failed through the state machine", async (behaviour) => {
    fake.createBehaviour = behaviour;
    const r = await place("razorpay");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("No money has been taken");
    const o = await db.order.findFirstOrThrow({ where: { customerName: "SMOKE TEST Flow" }, orderBy: { createdAt: "desc" }, include: { payments: true } });
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed", razorpayOrderId: null });
    expect(o.payments[0]).toMatchObject({ status: "failed", needsReconciliation: false });
    const ev = await db.orderEvent.findMany({ where: { orderId: o.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "system", toStatus: "cancelled", toPaymentStatus: "failed" });
  });

  it("gateway order created but local persistence fails → ambiguous, not cancelled, recoverable by receipt", async () => {
    const name = `vv_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN IF NEW."providerOrderId" IS NOT NULL THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    let r;
    try {
      r = await place("razorpay");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "Payment"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    expect(r.status).toBe(502);
    const o = await db.order.findUniqueOrThrow({ where: { number: r.body.orderNumber }, include: { payments: true } });
    created.push(o.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", razorpayOrderId: null });
    expect(o.payments[0]).toMatchObject({ providerOrderId: null, status: "unpaid" });
    expect([...fake.orders.values()].some((g) => g.receipt === o.number)).toBe(true); // the gateway order exists: reconciliation can find it
  });
});
