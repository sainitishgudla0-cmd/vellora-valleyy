import "server-only";
import { log } from "@/lib/log";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { cancelAfterGatewayFailure } from "./checkout";
import { applyGatewayPayment } from "./razorpay-verify";
import { createRazorpayProvider, GatewayError } from "./providers/razorpay";

/**
 * Recovery for Razorpay attempts whose outcome was unknown (M2-T5, ADR 0009). Webhooks are M10, so until then
 * this is the only way an authorized-then-captured payment, or an order whose gateway call was lost, settles.
 * Run by an operator via `npm run payments:reconcile` (guarded) or a future scheduler. Never cancels an order
 * whose gateway state it could not read, and only acts on attempts created under the current mode.
 */
export interface ReconcileSummary {
  checked: number;
  paid: number;
  attached: number;
  cancelled: number;
  pending: number;
  cleared: number;
  skipped: number;
  errors: number;
}

export const STALE_CREATE_MS = 30 * 60_000;

export async function reconcilePendingPayments(config: PaymentConfig, opts: { limit?: number; now?: Date; staleCreateMs?: number } = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, paid: 0, attached: 0, cancelled: 0, pending: 0, cleared: 0, skipped: 0, errors: 0 };
  if (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") return summary;
  const provider = createRazorpayProvider(config);
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (opts.staleCreateMs ?? STALE_CREATE_MS));

  const attempts = await db.payment.findMany({
    where: { needsReconciliation: true, provider: "razorpay", mode: config.mode, status: { in: ["unpaid", "failed"] }, order: { status: "awaiting_payment", paymentMode: config.mode } },
    include: { order: { select: { id: true, number: true, total: true, paymentStatus: true } } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
  });

  for (const a of attempts) {
    summary.checked++;
    try {
      if (!a.providerOrderId) {
        // The gateway call's outcome was lost. Look the order up by receipt (our order number).
        const found = (await provider.gateway.findOrdersByReceipt(a.order.number)).filter((o) => o.receipt === a.order.number && o.amount === a.amount && o.currency === "INR");
        if (found.length === 1) {
          const ref = found[0].id;
          const attached = await db.$transaction(async (tx) => {
            const p = await tx.payment.updateMany({ where: { id: a.id, providerOrderId: null, status: { in: ["unpaid", "failed"] } }, data: { providerOrderId: ref, lastCheckedAt: now } });
            const o = await tx.order.updateMany({ where: { id: a.order.id, razorpayOrderId: null, status: "awaiting_payment" }, data: { razorpayOrderId: ref } });
            return p.count === 1 && o.count === 1;
          });
          if (attached) summary.attached++;
          else summary.skipped++;
        } else if (found.length === 0 && a.createdAt < staleBefore) {
          await cancelAfterGatewayFailure(a.order.id, a.id, "create_never_completed");
          summary.cancelled++;
        } else {
          await db.payment.update({ where: { id: a.id }, data: { lastCheckedAt: now } });
          summary.skipped++; // too recent, or ambiguous (several candidates): leave for a human
        }
        continue;
      }

      const payments = (await provider.gateway.listOrderPayments(a.providerOrderId)).filter((p) => p.orderId === a.providerOrderId);
      const captured = payments.find((p) => p.status === "captured");
      if (captured) {
        const r = await applyGatewayPayment({ order: a.order, attempt: a, gp: captured, expectedOrderId: a.providerOrderId });
        if (r.kind === "paid" || r.kind === "already_paid") summary.paid++;
        else summary.skipped++;
      } else if (payments.some((p) => p.status === "authorized" || p.status === "created")) {
        await db.payment.update({ where: { id: a.id }, data: { lastCheckedAt: now } });
        summary.pending++;
      } else {
        await db.payment.update({ where: { id: a.id }, data: { needsReconciliation: false, reconcileReason: null, lastCheckedAt: now } }); // nothing settling: a normal awaiting-payment order
        summary.cleared++;
      }
    } catch (e) {
      summary.errors++; // gateway unavailable or similar: retry on the next run; never guess
      log.error("reconcile.attempt_check_failed", { order: a.order.number, reason: e instanceof GatewayError ? e.kind : "unexpected" });
    }
  }
  return summary;
}
