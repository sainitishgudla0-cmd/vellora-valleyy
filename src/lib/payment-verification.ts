import crypto from "node:crypto";

/**
 * Pure decision logic for POST /api/payments/razorpay/verify (no I/O, unit-tested).
 * Rules (docs/API-CONTRACTS.md#payment-verify):
 * - An invalid signature never mutates payment state.
 * - Only an order in status awaiting_payment (paymentStatus unpaid|failed) can become paid.
 * - A repeat of the same verified payment is an idempotent success.
 * - Anything else (cancelled order, a different payment for an already-paid order) is a conflict
 *   that is logged for manual reconciliation and never applied automatically.
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

export type ConflictReason = "different_payment" | "not_awaiting_payment";

export type VerifyDecision =
  | { kind: "not_found" }
  | { kind: "invalid_signature" }
  | { kind: "already_paid" }
  | { kind: "conflict"; reason: ConflictReason }
  | { kind: "mark_paid" };

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

export function decideVerification(
  order: VerifiableOrder | null,
  input: VerifyInput,
  isSignatureValid: (orderId: string, paymentId: string, signature: string) => boolean,
): VerifyDecision {
  if (!matchesOrder(order, input)) return { kind: "not_found" };
  if (!isSignatureValid(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) return { kind: "invalid_signature" };

  if (order.paymentStatus === "paid") {
    return order.razorpayPaymentId === input.razorpay_payment_id ? { kind: "already_paid" } : { kind: "conflict", reason: "different_payment" };
  }
  if (order.status !== "awaiting_payment" || !(PAYABLE_PAYMENT_STATUSES as readonly string[]).includes(order.paymentStatus)) {
    return { kind: "conflict", reason: "not_awaiting_payment" };
  }
  return { kind: "mark_paid" };
}
