import "server-only";
import { log } from "@/lib/log";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { applyGatewayPayment } from "@/lib/payments/razorpay-verify";
import { createRazorpayProvider, GatewayError } from "@/lib/payments/providers/razorpay";
import { ORPHAN_REASONS } from "@/lib/payments/refunds";
import { deleteExpiredKeys } from "./idempotency";
import { transitionOrder } from "./state-machine";

/**
 * Expiry of unpaid online orders (M3-T3, ADR 0011). An `awaiting_payment` order holds stock; if the customer never
 * pays it is cancelled through the state machine (which releases the hold), after the gateway has been asked
 * whether money is on its way. Never cancels on a gateway answer it could not read, and never cancels an order
 * whose payment is authorized (money held, outcome undecided) or already captured (that one is marked paid).
 * Pay-on-delivery orders are NOT expired: their hold lasts until staff confirm or cancel them (documented risk).
 *
 * M11 P1-T3 (F06): an attempt whose payment FAILED is expired like an unpaid one (it used to hold stock forever). A
 * customer may retry a failed payment on the same gateway order inside the window; a failure newer than
 * RETRY_GRACE_MINUTES also defers expiry, so a customer who just saw "payment failed" can try again. Orphan-capture
 * rows (captured money waiting for a refund) are never selected. A capture that lands after expiry is recorded as an
 * orphan by the webhook, by `applyGatewayPayment`, or by reconciliation's late-capture check (`reconcile.ts`).
 */
export const DEFAULT_PAYMENT_WINDOW_MINUTES = 60;
export const MIN_PAYMENT_WINDOW_MINUTES = 15;
export const RETRY_GRACE_MINUTES = 15;

export interface ExpireSummary {
  checked: number;
  expired: number;
  paid: number;
  pending: number;
  skipped: number;
  errors: number;
  keysDeleted: number;
}

class Abort extends Error {}

export async function expireUnpaidOrders(config: PaymentConfig, opts: { windowMinutes?: number; limit?: number; now?: Date } = {}): Promise<ExpireSummary> {
  const summary: ExpireSummary = { checked: 0, expired: 0, paid: 0, pending: 0, skipped: 0, errors: 0, keysDeleted: 0 };
  const now = opts.now ?? new Date();
  const windowMinutes = Math.max(MIN_PAYMENT_WINDOW_MINUTES, Math.floor(opts.windowMinutes ?? DEFAULT_PAYMENT_WINDOW_MINUTES));
  summary.keysDeleted = await deleteExpiredKeys(now);
  if (config.mode !== "mock" && config.mode !== "razorpay_test" && config.mode !== "razorpay_live") return summary;

  const cutoff = new Date(now.getTime() - windowMinutes * 60_000);
  const graceCutoff = new Date(now.getTime() - RETRY_GRACE_MINUTES * 60_000);
  const attempts = await db.payment.findMany({
    where: {
      status: { in: ["unpaid", "failed"] },
      mode: config.mode,
      providerPaymentId: null, // the order's attempt; a row with a gateway payment id but not paid is an orphan capture
      OR: [{ reconcileReason: null }, { reconcileReason: { notIn: [...ORPHAN_REASONS] } }],
      order: { status: "awaiting_payment", paymentStatus: { in: ["unpaid", "failed"] }, paymentMode: config.mode, createdAt: { lt: cutoff } },
    },
    include: {
      order: {
        select: {
          id: true,
          number: true,
          total: true,
          paymentStatus: true,
          // the latest recorded failure: a recent one means the customer may be retrying right now
          events: { where: { toPaymentStatus: "failed" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
  });
  const provider = config.mode === "mock" ? null : createRazorpayProvider(config);

  for (const a of attempts) {
    summary.checked++;
    const lastFailure = a.order.events[0]?.createdAt;
    if (a.order.paymentStatus === "failed" && lastFailure && lastFailure > graceCutoff) {
      summary.pending++; // failed moments ago: the customer may be retrying on the same gateway order
      continue;
    }
    try {
      if (provider) {
        if (!a.providerOrderId) {
          summary.skipped++; // gateway call never finished: payments:reconcile owns that case
          continue;
        }
        const payments = (await provider.gateway.listOrderPayments(a.providerOrderId)).filter((p) => p.orderId === a.providerOrderId);
        const captured = payments.find((p) => p.status === "captured");
        if (captured) {
          const r = await applyGatewayPayment({ order: a.order, attempt: a, gp: captured, expectedOrderId: a.providerOrderId });
          if (r.kind === "paid" || r.kind === "already_paid") summary.paid++;
          else summary.skipped++;
          continue;
        }
        if (payments.some((p) => p.status === "authorized")) {
          summary.pending++;
          continue;
        }
        // only abandoned ("created") or failed gateway attempts remain: nothing is paying this order any more
      }
      const ok = await db
        .$transaction(async (tx) => {
          // Claims the attempt in the state we read (row lock): a concurrent capture that already marked it paid makes
          // this match nothing. One that commits after us still claims the failed row, but its order transition then
          // finds the order cancelled, rolls back, and the capture is recorded as an orphan (razorpay-verify.ts).
          const p = await tx.payment.updateMany({
            where: { id: a.id, status: a.status, providerPaymentId: null },
            data: { status: "failed", needsReconciliation: false, reconcileReason: "payment_window_expired", lastCheckedAt: now },
          });
          if (p.count !== 1) throw new Abort();
          const reason = `Payment not completed within ${windowMinutes} minutes`;
          // An order whose payment already failed keeps `failed` (failed -> failed is not a transition); the conditional
          // update on status `awaiting_payment` still loses to anything that paid or cancelled it first.
          const r = await transitionOrder(
            a.order.paymentStatus === "unpaid"
              ? { orderId: a.order.id, from: "awaiting_payment", to: "cancelled", payment: { from: "unpaid", to: "failed" }, actor: { type: "system", id: "expiry" }, reason }
              : { orderId: a.order.id, from: "awaiting_payment", to: "cancelled", actor: { type: "system", id: "expiry" }, reason },
            tx,
          );
          if (!r.ok) throw new Abort();
          return true;
        })
        .catch((e) => {
          if (e instanceof Abort) return false; // someone moved the order first (paid, cancelled): leave it alone
          throw e;
        });
      if (ok) summary.expired++;
      else summary.skipped++;
    } catch (e) {
      summary.errors++; // gateway unavailable or database failure: retry on the next run, never guess
      log.error("expire.attempt_check_failed", { order: a.order.number, reason: e instanceof GatewayError ? e.kind : "unexpected" });
    }
  }
  return summary;
}
