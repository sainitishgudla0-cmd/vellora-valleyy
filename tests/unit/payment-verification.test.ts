import { describe, expect, it } from "vitest";
import { matchesOrder, PAYABLE_PAYMENT_STATUSES, safeEqual, type VerifiableOrder } from "@/lib/payment-verification";

const order = (over: Partial<VerifiableOrder> = {}): VerifiableOrder => ({
  id: "o1", number: "VV-1", accessToken: "tok-secret", paymentMethod: "razorpay", status: "awaiting_payment", paymentStatus: "unpaid", razorpayOrderId: "order_1", razorpayPaymentId: null, ...over,
});
const input = (over: object = {}) => ({ token: "tok-secret", razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig", ...over });

describe("matchesOrder", () => {
  it("accepts the right token and gateway order", () => expect(matchesOrder(order(), input())).toBe(true));
  it.each([
    ["unknown order", null, input()],
    ["wrong token", order(), input({ token: "nope" })],
    ["wrong gateway order", order(), input({ razorpay_order_id: "order_2" })],
    ["pay-on-delivery order", order({ paymentMethod: "cod" }), input()],
    ["no gateway reference (mock/request-only)", order({ razorpayOrderId: null }), input()],
  ])("rejects %s", (_n, o, i) => expect(matchesOrder(o as VerifiableOrder | null, i)).toBe(false));
});

describe("helpers", () => {
  it("safeEqual compares exactly, regardless of length", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "aa")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
  it("only unpaid and failed payments are payable", () => expect([...PAYABLE_PAYMENT_STATUSES]).toEqual(["unpaid", "failed"]));
});
