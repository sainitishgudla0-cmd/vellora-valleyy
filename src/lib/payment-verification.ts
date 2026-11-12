import crypto from "node:crypto";

/**
 * Pure helpers for POST /api/payments/razorpay/verify (no I/O, unit-tested). The decision flow itself lives in
 * `src/lib/payments/razorpay-verify.ts` (M2-T5); see docs/API-CONTRACTS.md#payment-verify.
 */
export interface VerifiableOrder {
  id: string;
  number: string;
  accessToken: string;
  paymentMethod: string;
  status: string;
  paymentStatus: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
}

export interface VerifyInput {
  token: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** Payment statuses from which a verified payment may move an order to paid. */
export const PAYABLE_PAYMENT_STATUSES = ["unpaid", "failed"] as const;

export function safeEqual(a: string, b: string) {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/** True when the request refers to this order (correct token, Razorpay order, matching gateway order id). */
export function matchesOrder(order: VerifiableOrder | null, input: VerifyInput): order is VerifiableOrder {
  return (
    !!order &&
    order.paymentMethod === "razorpay" &&
    !!order.razorpayOrderId &&
    safeEqual(order.accessToken, input.token) &&
    order.razorpayOrderId === input.razorpay_order_id
  );
}
