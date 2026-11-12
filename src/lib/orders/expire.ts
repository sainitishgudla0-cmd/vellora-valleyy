import "server-only";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { applyGatewayPayment } from "@/lib/payments/razorpay-verify";
import { createRazorpayProvider, GatewayError } from "@/lib/payments/providers/razorpay";
import { deleteExpiredKeys } from "./idempotency";
import { transitionOrder } from "./state-machine";

/**
 * Expiry of unpaid online orders (M3-T3, ADR 0011). An `awaiting_payment` order holds stock; if the customer never
 * pays it is cancelled through the state machine (which releases the hold), after the gateway has been asked
 * whether money is on its way. Never cancels on a gateway answer it could not read, and never cancels an order
 * whose payment is authorized (money held, outcome undecided) or already captured (that one is marked paid).
 * Pay-on-delivery orders are NOT expired: their hold lasts until staff confirm or cancel them (documented risk).
 */
export const DEFAULT_PAYMENT_WINDOW_MINUTES = 60;
export const MIN_PAYMENT_WINDOW_MINUTES = 15;

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
  const attempts = await db.payment.findMany({
    where: {
      status: "unpaid",
      mode: config.mode,
      order: { status: "awaiting_payment", paymentStatus: "unpaid", paymentMode: config.mode, createdAt: { lt: cutoff } },
    },
    include: { order: { select: { id: true, number: true, total: true, paymentStatus: true } } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
  });
  const provider = config.mode === "mock" ? null : createRazorpayProvider(config);

  for (const a of attempts) {
    summary.checked++;
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
          const p = await tx.payment.updateMany({ where: { id: a.id, status: "unpaid" }, data: { status: "failed", needsReconciliation: false, reconcileReason: "payment_window_expired" } });
          if (p.count !== 1) throw new Abort();
          const r = await transitionOrder(
            { orderId: a.order.id, from: "awaiting_payment", to: "cancelled", payment: { from: "unpaid", to: "failed" }, actor: { type: "system", id: "expiry" }, reason: `Payment not completed within ${windowMinutes} minutes` },
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
      console.error(`[expire] check failed order=${a.order.number} kind=${e instanceof GatewayError ? e.kind : "unexpected"}`);
    }
  }
  return summary;
}
