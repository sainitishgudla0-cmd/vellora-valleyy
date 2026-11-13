/**
 * Razorpay verification against a real Postgres with a deterministic fake gateway (scenarios D–G, I–L).
 * Replaces the M1 tests, whose intent (no mutation on bad input, idempotency, races) is kept.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createFixtureOrder, createMockOrderWithAttempt, createRazorpayOrderWithAttempt } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as verifyRoute } from "@/app/api/payments/razorpay/verify/route";

let fake: FakeRazorpay;
let variantId: string;
let errors: ReturnType<typeof vi.spyOn>;
const customer = { customerName: "SMOKE TEST Verify", email: "smoke.verify@example.com", phone: "9876543210", addressLine1: "1 Test Street", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" };

const post = async (route: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await route(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
/** A real checkout through POST /api/orders (fake gateway), returning what the browser would hold. */
async function checkout() {
  const r = await post(createOrderRoute, { ...customer, paymentMethod: "razorpay", items: [{ variantId, quantity: 1 }] });
  expect(r.status).toBe(201);
  return { number: r.body.order.number as string, token: r.body.order.token as string, gw: r.body.payment.orderId as string, total: r.body.order.total as number };
}
const verify = (c: { number: string; token: string; gw: string }, paymentId: string, over: Record<string, unknown> = {}) =>
  post(verifyRoute, { orderNumber: c.number, token: c.token, razorpay_order_id: c.gw, razorpay_payment_id: paymentId, razorpay_signature: fake.signature(c.gw, paymentId), ...over });
const load = (number: string) => db.order.findUniqueOrThrow({ where: { number }, include: { payments: true } });
const events = (orderId: string) => db.orderEvent.count({ where: { orderId } });
const untouched = async (number: string) => {
  const o = await load(number);
  expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", razorpayPaymentId: null });
  expect(o.payments[0]).toMatchObject({ status: "unpaid", providerPaymentId: null });
  expect(await events(o.id)).toBe(0);
};

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  rate.rateLimit.mockResolvedValue(true);
  vi.stubEnv("LOG_LEVEL", "error"); // the structured logger is quiet under test unless asked; these tests assert on what it writes
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeRazorpay().install();
  variantId ??= (await db.variant.findFirstOrThrow({ where: { inStock: true, product: { active: true } } })).id;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.order.deleteMany({ where: { customerName: "SMOKE TEST Verify" } });
  await cleanupFixtures();
  await db.$disconnect();
});

describe("D. invalid input never mutates financial state", () => {
  it("bad signature → 400 and nothing changes (even for a captured payment)", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const r = await verify(c, pay.id, { razorpay_signature: "0".repeat(64) });
    expect(r.status).toBe(400);
    expect(fake.calls.filter((x) => x.includes("/payments/"))).toEqual([]); // rejected before any gateway lookup
    await untouched(c.number);
  });
  it("signature made with another secret, wrong order id binding, empty signature", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    expect((await verify(c, pay.id, { razorpay_signature: fake.signature(c.gw, pay.id, "other_secret") })).status).toBe(400);
    expect((await verify(c, pay.id, { razorpay_signature: fake.signature("order_other", pay.id) })).status).toBe(400);
    expect((await verify(c, pay.id, { razorpay_signature: "" })).status).toBe(400);
    await untouched(c.number);
  });
  it("wrong token or wrong gateway order id → 404, nothing changes", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    expect((await verify(c, pay.id, { token: "nope" })).status).toBe(404);
    expect((await verify(c, pay.id, { razorpay_order_id: "order_someoneelse" })).status).toBe(404);
    await untouched(c.number);
  });
  it("schema violations → 422", async () => {
    expect((await post(verifyRoute, { orderNumber: "x" })).status).toBe(422);
  });
});

describe("E. valid signature but the payment is not provably captured", () => {
  it.each(["authorized", "created"])("%s → 202 pending, nothing paid, attempt flagged for reconciliation", async (status) => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, status);
    const r = await verify(c, pay.id);
    expect(r).toMatchObject({ status: 202, body: { ok: false, pending: true } });
    const o = await load(c.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(o.payments[0]).toMatchObject({ status: "unpaid", needsReconciliation: true, reconcileReason: `gateway_${status}` });
    expect(await events(o.id)).toBe(0);
  });

  it.each([
    ["amount", { amount: 1 }],
    ["currency", { currency: "USD" }],
    ["gateway order", { order_id: "order_other" }],
  ])("captured but %s differs from our records → 409, nothing paid, flagged", async (_n, over) => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured", over);
    expect((await verify(c, pay.id)).status).toBe(409);
    const o = await load(c.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(o.payments[0]).toMatchObject({ status: "unpaid", needsReconciliation: true, reconcileReason: "gateway_mismatch" });
    expect(await events(o.id)).toBe(0);
  });

  it("the attempt amount disagreeing with the order total → 409 before any gateway lookup", async () => {
    const c = await checkout();
    await db.payment.updateMany({ where: { order: { number: c.number } }, data: { amount: 1 } });
    const pay = fake.addPayment(c.gw, "captured");
    expect((await verify(c, pay.id)).status).toBe(409);
    expect(fake.calls.filter((x) => x.includes("/payments/"))).toEqual([]);
    expect((await load(c.number)).paymentStatus).toBe("unpaid");
  });

  it("gateway unreachable → 503 retryable, nothing paid or failed, flagged", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    for (const mode of ["timeout", "http500"] as const) {
      fake.paymentLookup = mode;
      expect((await verify(c, pay.id)).status).toBe(503);
    }
    const o = await load(c.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(o.payments[0]).toMatchObject({ status: "unpaid", needsReconciliation: true, reconcileReason: "verify_gateway_unavailable" });
    fake.paymentLookup = "ok";
    expect((await verify(c, pay.id)).status).toBe(200); // retry succeeds once the gateway answers
  });

  it("payment unknown to the gateway (valid signature) → 409, nothing paid", async () => {
    const c = await checkout();
    expect((await verify(c, "pay_neverexisted")).status).toBe(409);
    expect((await load(c.number)).paymentStatus).toBe("unpaid");
  });

  it("gateway reports failed → 400, attempt and payment failed (order stays awaiting payment); a later capture still succeeds", async () => {
    const c = await checkout();
    const failed = fake.addPayment(c.gw, "failed");
    expect((await verify(c, failed.id)).status).toBe(400);
    const o = await load(c.number);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed" });
    expect(o.payments[0].status).toBe("failed");
    const retry = fake.addPayment(c.gw, "captured");
    expect((await verify(c, retry.id)).status).toBe(200);
    expect(await load(c.number)).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: retry.id });
  });

  it("a failed report can never overwrite a payment that is already paid", async () => {
    const c = await checkout();
    const good = fake.addPayment(c.gw, "captured");
    await verify(c, good.id);
    const bad = fake.addPayment(c.gw, "failed");
    const r = await verify(c, bad.id);
    expect(r.status).toBe(409); // already paid with a different payment id
    expect(await load(c.number)).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: good.id });
    expect((await load(c.number)).payments[0].status).toBe("paid");
  });
});

describe("F/G. duplicates and races", () => {
  it("duplicate callback → second call is an idempotent success with no new event", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    expect((await verify(c, pay.id)).body).toEqual({ ok: true });
    expect((await verify(c, pay.id)).body).toEqual({ ok: true, alreadyVerified: true });
    const o = await load(c.number);
    expect(await events(o.id)).toBe(1);
  });

  it("10 simultaneous identical verifications → one financial transition, one event, consistent final state", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const rs = await Promise.all(Array.from({ length: 10 }, () => verify(c, pay.id)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => !r.body.alreadyVerified)).toHaveLength(1);
    const o = await load(c.number);
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: pay.id });
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ status: "paid", providerPaymentId: pay.id });
    expect(await events(o.id)).toBe(1);
  });

  it("two different captured payments racing for one order → exactly one wins", async () => {
    const c = await checkout();
    const p1 = fake.addPayment(c.gw, "captured");
    const p2 = fake.addPayment(c.gw, "captured");
    const rs = await Promise.all([verify(c, p1.id), verify(c, p2.id)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const o = await load(c.number);
    expect(["pay", o.razorpayPaymentId === p1.id || o.razorpayPaymentId === p2.id ? "pay" : "none"]).toEqual(["pay", "pay"]);
    expect(o.payments[0].providerPaymentId).toBe(o.razorpayPaymentId);
    expect(await events(o.id)).toBe(1);
  });

  it("the same gateway payment id cannot pay a second order", async () => {
    const a = await checkout();
    const b = await checkout();
    const pay = fake.addPayment(a.gw, "captured");
    expect((await verify(a, pay.id)).status).toBe(200);
    // attacker presents a signature valid for B's order id with A's payment id: gateway lookup shows it belongs to A's order
    fake.payments.set(pay.id, { ...pay, order_id: b.gw });
    expect((await verify(b, pay.id)).status).toBe(409);
    await untouched(b.number);
  });

  it("a payment id already recorded on another attempt is refused by the unique constraint", async () => {
    const a = await checkout();
    const b = await checkout();
    const pa = fake.addPayment(a.gw, "captured");
    await verify(a, pa.id);
    const pb = fake.addPayment(b.gw, "captured", { id: pa.id }); // gateway claims the same id for B's order
    fake.payments.set(pa.id, pb);
    expect((await verify(b, pa.id)).status).toBe(409);
    await untouched(b.number);
  });
});

describe("I. cancellation", () => {
  it("a cancelled order cannot be paid: 409, nothing changes", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const o = await load(c.number);
    const { transitionOrder } = await import("@/lib/orders/state-machine");
    expect((await transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "cancelled", actor: { type: "admin", id: "a" }, reason: "customer asked" })).ok).toBe(true);
    expect((await verify(c, pay.id)).status).toBe(409);
    expect(await load(c.number)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    const a = (await load(c.number)).payments[0];
    expect(a.status).toBe("unpaid");
    expect(a).toMatchObject({ needsReconciliation: true, reconcileReason: "payment_on_non_payable_order" }); // visible to operators: a captured payment may exist
  });

  it("verification racing with cancellation → never both", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const o = await load(c.number);
    const { transitionOrder } = await import("@/lib/orders/state-machine");
    const [v, cancel] = await Promise.all([verify(c, pay.id), transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "cancelled", actor: { type: "admin", id: "a" }, reason: "race" })]);
    const after = await load(c.number);
    if (cancel.ok) {
      expect(v.status).toBe(409);
      expect(after).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    } else {
      expect(v.status).toBe(200);
      expect(after).toMatchObject({ status: "paid", paymentStatus: "paid" });
    }
    expect(await events(after.id)).toBe(1);
  });
});

describe("J/K. wrong kind of order, wrong mode, legacy orders", () => {
  it("request-only (COD) order → 404", async () => {
    const o = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation" });
    const r = await post(verifyRoute, { orderNumber: o.number, token: o.accessToken, razorpay_order_id: "order_x", razorpay_payment_id: "pay_x", razorpay_signature: fake.signature("order_x", "pay_x") });
    expect(r.status).toBe(404);
  });

  it("mock order → 404 (no gateway reference)", async () => {
    const f = await createMockOrderWithAttempt();
    const r = await post(verifyRoute, { orderNumber: f.order.number, token: f.token, razorpay_order_id: f.providerOrderId, razorpay_payment_id: "pay_x", razorpay_signature: fake.signature(f.providerOrderId, "pay_x") });
    expect(r.status).toBe(404);
    expect((await load(f.order.number)).status).toBe("awaiting_payment");
  });

  it("legacy order (paymentMode NULL) with a gateway reference and a valid captured payment → 409 manual reconciliation, no guess, no gateway call", async () => {
    const f = await createRazorpayOrderWithAttempt({ mode: null });
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total });
    const r = await post(verifyRoute, { orderNumber: f.order.number, token: f.token, razorpay_order_id: f.providerOrderId, razorpay_payment_id: pay.id, razorpay_signature: fake.signature(f.providerOrderId!, pay.id) });
    expect(r.status).toBe(409);
    expect(errors.mock.calls.flat().join(" ")).toContain("legacy_unclassified");
    expect(fake.calls).toEqual([]);
    expect(await load(f.order.number)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paymentMode: null });
  });

  it("order created under razorpay_live while the server is razorpay_test → 409, no gateway call", async () => {
    const f = await createRazorpayOrderWithAttempt({ mode: "razorpay_live" });
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total });
    const r = await post(verifyRoute, { orderNumber: f.order.number, token: f.token, razorpay_order_id: f.providerOrderId, razorpay_payment_id: pay.id, razorpay_signature: fake.signature(f.providerOrderId!, pay.id) });
    expect(r.status).toBe(409);
    expect(fake.calls).toEqual([]);
    expect((await load(f.order.number)).paymentStatus).toBe("unpaid");
  });

  it("a Razorpay order without a matching attempt row → 409", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    await db.payment.deleteMany({ where: { orderId: f.order.id } });
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total });
    const r = await post(verifyRoute, { orderNumber: f.order.number, token: f.token, razorpay_order_id: f.providerOrderId, razorpay_payment_id: pay.id, razorpay_signature: fake.signature(f.providerOrderId!, pay.id) });
    expect(r.status).toBe(409);
  });

  it.each([["request_only"], ["mock"]])("503 and no writes when the server runs in %s mode", async (mode) => {
    const c = await checkout();
    vi.stubEnv("PAYMENT_MODE", mode);
    const pay = fake.addPayment(c.gw, "captured");
    expect((await verify(c, pay.id)).status).toBe(503);
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    await untouched(c.number);
  });
});

describe("L. transaction failure leaves no partial financial update", () => {
  it("if the OrderEvent insert fails the attempt and order stay unpaid; a retry then succeeds", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const o = await load(c.number);
    const name = `vv_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "OrderEvent" FOR EACH ROW WHEN (NEW."orderId" = '${o.id}') EXECUTE FUNCTION ${name}()`);
    try {
      await expect(verify(c, pay.id)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "OrderEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    await untouched(c.number);
    expect((await verify(c, pay.id)).status).toBe(200);
  });
});

describe("secrets and personal data never leak", () => {
  it("responses and logs contain no key secret, token, signature, phone or email across success, failure and conflict paths", async () => {
    const c = await checkout();
    const pay = fake.addPayment(c.gw, "captured");
    const sig = fake.signature(c.gw, pay.id);
    const outputs = [
      await verify(c, pay.id, { razorpay_signature: "0".repeat(64) }),
      await verify(c, "pay_neverexisted"),
      await verify(c, pay.id),
      await verify(c, pay.id),
      await verify(c, fake.addPayment(c.gw, "failed").id),
    ];
    const everything = JSON.stringify(outputs) + errors.mock.calls.flat().join(" ");
    for (const secret of [TEST_KEY_SECRET, c.token, sig, "9876543210", "smoke.verify@example.com"]) expect(everything).not.toContain(secret);
  });
});
