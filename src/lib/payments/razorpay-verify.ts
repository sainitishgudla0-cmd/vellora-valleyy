import "server-only";
import { log } from "@/lib/log";
import { Prisma, type PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { transitionOrder } from "@/lib/orders/state-machine";
import { matchesOrder, PAYABLE_PAYMENT_STATUSES, type VerifyInput } from "@/lib/payment-verification";
import { flagForReconciliation } from "./checkout";
import { createRazorpayProvider, GatewayError, type GatewayPayment } from "./providers/razorpay";

/**
 * Razorpay checkout verification (M2-T5, ADR 0009). A browser-supplied signature is necessary but never
 * sufficient: an order is only marked paid after (1) the order, its token, mode and a matching payment attempt
 * are validated against server records, (2) the signature verifies, and (3) a server-side gateway lookup shows
 * the payment `captured` for exactly this gateway order, amount and currency. Anything unprovable leaves
 * financial state untouched and, where the outcome may still resolve, flags the attempt for reconciliation.
 */
export type RazorpayVerifyConflict =
  | "legacy_unclassified" // order.paymentMode is NULL: never guessed, needs a human
  | "mode_mismatch" // order was created under a different mode than the server's current one
  | "no_attempt" // no matching Payment attempt for this gateway order
  | "different_payment"
  | "not_payable" // cancelled, already progressed, or payment not unpaid/failed
  | "amount_mismatch"
  | "gateway_mismatch" // gateway reports a different order, amount or currency
  | "payment_id_in_use"
  | "stale";

export type RazorpayVerifyResult =
  | { kind: "paid" }
  | { kind: "already_paid" }
  | { kind: "not_found" }
  | { kind: "unavailable" } // online payments not configured / invalid config
  | { kind: "invalid_signature" }
  | { kind: "pending" } // authorized/created but not captured: nothing marked paid
  | { kind: "gateway_unavailable" } // could not reach the gateway: nothing marked paid, retryable
  | { kind: "payment_failed" }
  | { kind: "conflict"; reason: RazorpayVerifyConflict };

class Abort extends Error {
  constructor(public result: RazorpayVerifyResult) {
    super("verify aborted");
  }
}

const note = (order: string, event: string, reason?: string) => log.error(`payments.verify_${event}`, { order, reason }); // order number + code only

export async function verifyRazorpayCheckout(input: VerifyInput & { orderNumber: string }, config: PaymentConfig | null): Promise<RazorpayVerifyResult> {
  const order = await db.order.findUnique({
    where: { number: input.orderNumber },
    select: { id: true, number: true, accessToken: true, paymentMethod: true, paymentMode: true, status: true, paymentStatus: true, total: true, razorpayOrderId: true, razorpayPaymentId: true },
  });
  if (!matchesOrder(order, input)) return { kind: "not_found" };
  if (!config || (config.mode !== "razorpay_test" && config.mode !== "razorpay_live")) return { kind: "unavailable" };
  const provider = createRazorpayProvider(config);

  // Orders created before M2-T4 have no recorded mode and are never classified or paid automatically.
  if (order.paymentMode === null) return conflict(order.number, "legacy_unclassified");
  if (order.paymentMode !== config.mode) return conflict(order.number, "mode_mismatch");

  const attempt = await db.payment.findFirst({
    where: { orderId: order.id, provider: "razorpay", mode: order.paymentMode, providerOrderId: input.razorpay_order_id },
  });
  if (!attempt) return conflict(order.number, "no_attempt");

  // Invalid signatures never reach any write path.
  if (!provider.verifyPayment({ providerOrderId: input.razorpay_order_id, providerPaymentId: input.razorpay_payment_id, signature: input.razorpay_signature })) {
    return { kind: "invalid_signature" };
  }

  if (attempt.status === "paid") {
    return attempt.providerPaymentId === input.razorpay_payment_id ? { kind: "already_paid" } : conflict(order.number, "different_payment");
  }
  if (order.paymentStatus === "paid") return conflict(order.number, "different_payment");
  if (order.status !== "awaiting_payment" || !(PAYABLE_PAYMENT_STATUSES as readonly string[]).includes(order.paymentStatus)) {
    // a validly signed payment for an order that can no longer take it (e.g. cancelled): money may have moved, so a human must see it
    await flagForReconciliation(attempt.id, "payment_on_non_payable_order");
    return conflict(order.number, "not_payable");
  }
  if (attempt.amount !== order.total || attempt.currency !== "INR") {
    await flagForReconciliation(attempt.id, "amount_mismatch");
    return conflict(order.number, "amount_mismatch");
  }

  let gp: GatewayPayment;
  try {
    gp = await provider.gateway.fetchPayment(input.razorpay_payment_id);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not_found") {
      await flagForReconciliation(attempt.id, "payment_not_found_at_gateway");
      return conflict(order.number, "gateway_mismatch");
    }
    note(order.number, "gateway_lookup_failed", e instanceof GatewayError ? e.kind : "unexpected");
    await flagForReconciliation(attempt.id, "verify_gateway_unavailable");
    return { kind: "gateway_unavailable" };
  }

  return applyGatewayPayment({ order, attempt, gp, expectedOrderId: input.razorpay_order_id });
}

export interface ApplyInput {
  order: { id: string; number: string; paymentStatus: PaymentStatus; total: number };
  attempt: { id: string; amount: number };
  gp: GatewayPayment;
  expectedOrderId: string;
}

/** Shared by checkout verification and reconciliation: acts on a gateway-reported payment for an already-validated attempt. */
export async function applyGatewayPayment({ order, attempt, gp, expectedOrderId }: ApplyInput): Promise<RazorpayVerifyResult> {
  if (gp.orderId !== expectedOrderId || gp.amount !== attempt.amount || gp.currency !== "INR") {
    await flagForReconciliation(attempt.id, "gateway_mismatch");
    return conflict(order.number, "gateway_mismatch");
  }
  switch (gp.status) {
    case "captured":
      return markPaid(order, attempt, gp.id);
    case "failed":
      return markFailed(order, attempt);
    case "refunded":
      await flagForReconciliation(attempt.id, "gateway_refunded");
      return conflict(order.number, "gateway_mismatch");
    default: // authorized, created, ...: money is not settled yet
      await db.payment.updateMany({ where: { id: attempt.id, status: { in: ["unpaid", "failed"] } }, data: { needsReconciliation: true, reconcileReason: `gateway_${gp.status}`.slice(0, 40), lastCheckedAt: new Date() } });
      return { kind: "pending" };
  }
}

async function markPaid(order: ApplyInput["order"], attempt: { id: string; amount: number }, providerPaymentId: string): Promise<RazorpayVerifyResult> {
  if (order.paymentStatus !== "unpaid" && order.paymentStatus !== "failed") return conflict(order.number, "not_payable");
  try {
    await db.$transaction(async (tx) => {
      // conditional claim of the attempt: amount/currency/provider pinned, status unpaid|failed
      const claimed = await tx.payment.updateMany({
        where: { id: attempt.id, status: { in: ["unpaid", "failed"] }, provider: "razorpay", amount: order.total, currency: "INR" },
        data: { status: "paid", providerPaymentId, needsReconciliation: false, reconcileReason: null, lastCheckedAt: new Date() },
      });
      if (claimed.count === 0) throw new Abort({ kind: "conflict", reason: "stale" });
      const moved = await transitionOrder(
        {
          orderId: order.id,
          from: "awaiting_payment",
          to: "paid",
          payment: { from: order.paymentStatus, to: "paid" },
          actor: { type: "gateway", id: "razorpay" },
          reason: "Verified captured Razorpay payment",
          data: { razorpayPaymentId: providerPaymentId },
        },
        tx,
      );
      if (!moved.ok) throw new Abort({ kind: "conflict", reason: moved.code === "stale_state" ? "not_payable" : "stale" });
    });
    return { kind: "paid" };
  } catch (e) {
    if (e instanceof Abort) {
      // an identical concurrent verification may have won: that is the idempotent success
      const a = await db.payment.findUnique({ where: { id: attempt.id } });
      if (a?.status === "paid" && a.providerPaymentId === providerPaymentId) return { kind: "already_paid" };
      note(order.number, "conflict", e.result.kind === "conflict" ? e.result.reason : "?");
      return e.result;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return conflict(order.number, "payment_id_in_use"); // payment id already pays another order
    throw e;
  }
}

async function markFailed(order: ApplyInput["order"], attempt: { id: string }): Promise<RazorpayVerifyResult> {
  // Only ever unpaid -> failed. A paid payment is never overwritten (conditional on both rows).
  if (order.paymentStatus === "unpaid") {
    try {
      await db.$transaction(async (tx) => {
        const a = await tx.payment.updateMany({ where: { id: attempt.id, status: "unpaid" }, data: { status: "failed", lastCheckedAt: new Date() } });
        if (a.count === 0) throw new Abort({ kind: "conflict", reason: "stale" });
        const r = await transitionOrder(
          { orderId: order.id, from: "awaiting_payment", to: "awaiting_payment", payment: { from: "unpaid", to: "failed" }, actor: { type: "gateway", id: "razorpay" }, reason: "Gateway reported the payment failed" },
          tx,
        );
        if (!r.ok) throw new Abort({ kind: "conflict", reason: "stale" });
      });
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      return e.result.kind === "conflict" ? e.result : conflict(order.number, "stale");
    }
  }
  return { kind: "payment_failed" };
}

function conflict(orderNumber: string, reason: RazorpayVerifyConflict): RazorpayVerifyResult {
  note(orderNumber, "conflict", reason);
  return { kind: "conflict", reason };
}
