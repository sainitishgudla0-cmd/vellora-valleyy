import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignatureWith } from "@/lib/payments/providers/razorpay";
import { isRefundablePayment, ORPHAN_REASONS } from "@/lib/payments/refunds";

const SECRET = "whsec_0123456789abcdef";
const sign = (body: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("verifyWebhookSignatureWith (raw-body HMAC)", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: {} });
  it("accepts the exact raw body signed with the webhook secret", () => {
    expect(verifyWebhookSignatureWith(SECRET, body, sign(body))).toBe(true);
  });
  it("rejects a different body, a different secret, whitespace changes and re-serialised JSON", () => {
    expect(verifyWebhookSignatureWith(SECRET, body + " ", sign(body))).toBe(false);
    expect(verifyWebhookSignatureWith(SECRET, JSON.stringify(JSON.parse(body), null, 2), sign(body))).toBe(false);
    expect(verifyWebhookSignatureWith(SECRET, body, sign(body, "another_secret_0123456789"))).toBe(false);
  });
  it("never throws and is false for missing, empty, wrong-length or non-hex signatures and an empty secret", () => {
    for (const sig of [null, "", "abc", "z".repeat(64), sign(body).toUpperCase(), sign(body) + "00"]) expect(verifyWebhookSignatureWith(SECRET, body, sig)).toBe(false);
    expect(verifyWebhookSignatureWith("", body, sign(body, ""))).toBe(false);
  });
});

describe("isRefundablePayment", () => {
  const p = (status: string, providerPaymentId: string | null, reconcileReason: string | null = null) => ({ status, providerPaymentId, reconcileReason });
  it("a paid payment with a gateway id is refundable", () => expect(isRefundablePayment(p("paid", "pay_1"))).toBe(true));
  it("never without a gateway payment id, and never when unpaid, failed or already refunded", () => {
    expect(isRefundablePayment(p("paid", null))).toBe(false);
    for (const s of ["unpaid", "failed", "refunded"]) expect(isRefundablePayment(p(s, "pay_1"))).toBe(false);
  });
  it("an unpaid row is refundable only as a recorded orphan capture", () => {
    for (const r of ORPHAN_REASONS) expect(isRefundablePayment(p("unpaid", "pay_1", r))).toBe(true);
    expect(isRefundablePayment(p("unpaid", "pay_1", "gateway_authorized"))).toBe(false);
  });
});
