import "server-only";
import { db } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/state-machine";
import { GatewayError } from "./providers/razorpay";
import type { PaymentProvider, ProviderPayment } from "./providers/types";

/**
 * Starts the online payment for a freshly created order (M2-T5, ADR 0009).
 *
 * The order and its pending `Payment` attempt were inserted atomically by `createOrder`. The gateway call that
 * follows cannot be part of a database transaction, so every outcome is handled explicitly:
 *  - ready:      the gateway reference was validated and persisted on the attempt and the order (one transaction);
 *  - definite:   the gateway refused or answered with something unusable. Nothing payable exists, so the order is
 *                cancelled through the state machine (payment -> failed);
 *  - ambiguous:  timeout, 5xx, or a failure persisting the reference. The gateway may or may not have created an
 *                order, but the client never receives a reference, so nothing can be paid. The order stays
 *                `awaiting_payment`, the attempt is flagged `needsReconciliation`, and `reconcile.ts` resolves it.
 *                We never claim success or failure we cannot prove, and never cancel on an unknown outcome.
 */
export type StartPaymentResult =
  | { kind: "ready"; clientPayload: ProviderPayment["clientPayload"] }
  | { kind: "definite" }
  | { kind: "ambiguous" };

interface OrderRef {
  id: string;
  number: string;
  total: number;
}

class Abort extends Error {}

export async function startOnlinePayment(order: OrderRef, attemptId: string, provider: PaymentProvider): Promise<StartPaymentResult> {
  let created: ProviderPayment | null;
  try {
    created = await provider.createPayment({ orderNumber: order.number, amountPaise: order.total, currency: "INR" });
  } catch (e) {
    if (e instanceof GatewayError && (e.kind === "rejected" || e.kind === "invalid_response")) {
      await cancelAfterGatewayFailure(order.id, attemptId, e.kind === "rejected" ? "gateway_rejected" : "gateway_invalid_response");
      return { kind: "definite" };
    }
    console.error(`[payments] gateway outcome unknown order=${order.number} reason=${e instanceof GatewayError ? e.kind : "unexpected"}`);
    await flagForReconciliation(attemptId, "create_outcome_unknown");
    return { kind: "ambiguous" };
  }
  if (!created) return { kind: "definite" }; // an online provider must produce a payment

  // mock attempts already carry their deterministic reference; razorpay attempts get theirs now
  if (provider.id === "mock") return { kind: "ready", clientPayload: created.clientPayload };

  try {
    await db.$transaction(async (tx) => {
      const a = await tx.payment.updateMany({
        where: { id: attemptId, providerOrderId: null, status: "unpaid", amount: order.total, currency: "INR" },
        data: { providerOrderId: created.providerOrderId, needsReconciliation: false, reconcileReason: null },
      });
      // Non-status write: attaches the gateway reference. Status/payment changes only go through transitionOrder.
      const o = await tx.order.updateMany({ where: { id: order.id, razorpayOrderId: null, status: "awaiting_payment" }, data: { razorpayOrderId: created.providerOrderId } });
      if (a.count !== 1 || o.count !== 1) throw new Abort();
    });
  } catch {
    console.error(`[payments] gateway order created but not persisted order=${order.number}`);
    await flagForReconciliation(attemptId, "persist_failed");
    return { kind: "ambiguous" };
  }
  return { kind: "ready", clientPayload: created.clientPayload };
}

export async function flagForReconciliation(attemptId: string, reason: string) {
  try {
    await db.payment.updateMany({ where: { id: attemptId, status: { in: ["unpaid", "failed"] } }, data: { needsReconciliation: true, reconcileReason: reason } });
  } catch {
    console.error(`[payments] could not flag attempt for reconciliation reason=${reason}`); // the attempt row stays unpaid with no reference: still findable
  }
}

/** Cancels an order whose gateway order definitively does not exist. Atomic with the attempt update. */
export async function cancelAfterGatewayFailure(orderId: string, attemptId: string, reason: string) {
  try {
    await db.$transaction(async (tx) => {
      await tx.payment.updateMany({ where: { id: attemptId, status: "unpaid" }, data: { status: "failed", needsReconciliation: false, reconcileReason: reason } });
      const r = await transitionOrder(
        { orderId, from: "awaiting_payment", to: "cancelled", payment: { from: "unpaid", to: "failed" }, actor: { type: "system", id: "checkout" }, reason: `Online payment could not be started (${reason})` },
        tx,
      );
      if (!r.ok) throw new Abort();
    });
  } catch {
    // stale (someone else already moved the order) or a database failure: leave it recoverable instead of guessing
    console.error(`[payments] could not cancel after gateway failure reason=${reason}`);
    await flagForReconciliation(attemptId, reason);
  }
}
