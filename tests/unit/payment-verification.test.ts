import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideVerification, type VerifiableOrder } from "@/lib/payment-verification";

// ---- shared fixtures -------------------------------------------------------
const SECRET = "unit_test_secret";
const sign = (orderId: string, paymentId: string) => crypto.createHmac("sha256", SECRET).update(`${orderId}|${paymentId}`).digest("hex");

const baseOrder = (over: Partial<VerifiableOrder> = {}): VerifiableOrder => ({
  id: "ord_1",
  number: "VV-261111-ABC123",
  accessToken: "tok_abc",
  paymentMethod: "razorpay",
  status: "awaiting_payment",
  paymentStatus: "unpaid",
  razorpayOrderId: "order_RZP1",
  razorpayPaymentId: null,
  ...over,
});
const input = (over: Record<string, string> = {}) => ({
  orderNumber: "VV-261111-ABC123",
  token: "tok_abc",
  razorpay_order_id: "order_RZP1",
  razorpay_payment_id: "pay_1",
  razorpay_signature: sign("order_RZP1", "pay_1"),
  ...over,
});
const validSig = (o: string, p: string, s: string) => s === sign(o, p);

// ---- pure decision ---------------------------------------------------------
describe("decideVerification", () => {
  it("marks an awaiting order paid on a valid signature", () => {
    expect(decideVerification(baseOrder(), input(), validSig)).toEqual({ kind: "mark_paid" });
    expect(decideVerification(baseOrder({ paymentStatus: "failed" }), input(), validSig)).toEqual({ kind: "mark_paid" });
  });
  it("treats unknown order, wrong token, wrong gateway order or a COD order as not found", () => {
    expect(decideVerification(null, input(), validSig).kind).toBe("not_found");
    expect(decideVerification(baseOrder(), input({ token: "nope" }), validSig).kind).toBe("not_found");
    expect(decideVerification(baseOrder(), input({ razorpay_order_id: "order_other" }), validSig).kind).toBe("not_found");
    expect(decideVerification(baseOrder({ paymentMethod: "cod" }), input(), validSig).kind).toBe("not_found");
    expect(decideVerification(baseOrder({ razorpayOrderId: null }), input(), validSig).kind).toBe("not_found");
  });
  it("rejects an invalid signature before looking at order state", () => {
    expect(decideVerification(baseOrder({ paymentStatus: "paid", razorpayPaymentId: "pay_1", status: "paid" }), input({ razorpay_signature: "deadbeef" }), validSig)).toEqual({
      kind: "invalid_signature",
    });
  });
  it("is idempotent for the same payment and flags a different payment on a paid order", () => {
    const paid = baseOrder({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" });
    expect(decideVerification(paid, input(), validSig)).toEqual({ kind: "already_paid" });
    const other = input({ razorpay_payment_id: "pay_2", razorpay_signature: sign("order_RZP1", "pay_2") });
    expect(decideVerification(paid, other, validSig)).toEqual({ kind: "conflict", reason: "different_payment" });
  });
  it("never marks a cancelled (or otherwise non-awaiting) order paid", () => {
    for (const status of ["cancelled", "confirmed", "dispatched", "pending_confirmation"]) {
      expect(decideVerification(baseOrder({ status }), input(), validSig)).toEqual({ kind: "conflict", reason: "not_awaiting_payment" });
    }
    expect(decideVerification(baseOrder({ paymentStatus: "refunded" }), input(), validSig)).toEqual({ kind: "conflict", reason: "not_awaiting_payment" });
  });
});

// ---- route handler (database mocked) ---------------------------------------
const dbMock = vi.hoisted(() => ({ order: { findUnique: vi.fn(), updateMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => true) }));

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/payments/razorpay/verify/route");
  const res = await POST(new Request("http://localhost/api/payments/razorpay/verify", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("POST /api/payments/razorpay/verify", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_unit");
    vi.stubEnv("RAZORPAY_KEY_SECRET", SECRET);
    dbMock.order.findUnique.mockReset();
    dbMock.order.updateMany.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("legitimate verification marks the order paid with a conditional update", async () => {
    dbMock.order.findUnique.mockResolvedValue(baseOrder());
    dbMock.order.updateMany.mockResolvedValue({ count: 1 });
    expect(await post(input())).toEqual({ status: 200, body: { ok: true } });
    expect(dbMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord_1", status: "awaiting_payment", paymentStatus: { in: ["unpaid", "failed"] } },
      data: { status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" },
    });
  });

  it("invalid signature on an already-paid order does NOT change payment state (M0 regression)", async () => {
    dbMock.order.findUnique.mockResolvedValue(baseOrder({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" }));
    const r = await post(input({ razorpay_signature: "0".repeat(64) }));
    expect(r.status).toBe(400);
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("invalid signature on an awaiting order does not mutate it either", async () => {
    dbMock.order.findUnique.mockResolvedValue(baseOrder());
    expect((await post(input({ razorpay_signature: "bad" }))).status).toBe(400);
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("a cancelled order is not silently marked paid", async () => {
    dbMock.order.findUnique.mockResolvedValue(baseOrder({ status: "cancelled" }));
    const r = await post(input());
    expect(r.status).toBe(409);
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("repeated verification of the same payment is an idempotent success without writes", async () => {
    dbMock.order.findUnique.mockResolvedValue(baseOrder({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" }));
    expect(await post(input())).toEqual({ status: 200, body: { ok: true, alreadyVerified: true } });
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("concurrent verification: losing the race to the same payment still succeeds", async () => {
    dbMock.order.findUnique
      .mockResolvedValueOnce(baseOrder())
      .mockResolvedValueOnce(baseOrder({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" }));
    dbMock.order.updateMany.mockResolvedValue({ count: 0 });
    expect(await post(input())).toEqual({ status: 200, body: { ok: true, alreadyVerified: true } });
  });

  it("losing the race to an admin cancellation returns 409", async () => {
    dbMock.order.findUnique.mockResolvedValueOnce(baseOrder()).mockResolvedValueOnce(baseOrder({ status: "cancelled" }));
    dbMock.order.updateMany.mockResolvedValue({ count: 0 });
    expect((await post(input())).status).toBe(409);
  });

  it("forged requests for unknown orders or with wrong tokens are 404", async () => {
    dbMock.order.findUnique.mockResolvedValue(null);
    expect((await post(input())).status).toBe(404);
    dbMock.order.findUnique.mockResolvedValue(baseOrder());
    expect((await post(input({ token: "wrong" }))).status).toBe(404);
  });

  it("fails closed with 503 and no writes when the payment configuration is invalid", async () => {
    vi.stubEnv("PAYMENT_MODE", "razorpay_live"); // not allowed in test
    dbMock.order.findUnique.mockResolvedValue(baseOrder());
    expect((await post(input())).status).toBe(503);
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies with 422", async () => {
    expect((await post({ orderNumber: "x" })).status).toBe(422);
  });
});
