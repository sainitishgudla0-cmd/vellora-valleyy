import "server-only";
import { log } from "@/lib/log";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { cancelAfterGatewayFailure } from "./checkout";
import { applyGatewayPayment } from "./razorpay-verify";
import { createRazorpayProvider, GatewayError, type RazorpayGateway } from "./providers/razorpay";
import { ORPHAN_REASONS, settleFullRefund, upsertRefundFromGateway } from "./refunds";

/**
 * Recovery for Razorpay attempts whose outcome was unknown (M2-T5, ADR 0009), and since M10 the backstop behind
 * the webhook: `reconcileGateway` also sweeps stale awaiting-payment orders (a dropped browser AND a missed webhook)
 * and settles pending refunds. Run by the scheduled route `GET /api/internal/payments/reconcile` or an operator via
 * `npm run payments:reconcile` (guarded). Never cancels an order whose gateway state it could not read, and only
 * acts on attempts created under the current mode. Every step is a conditional write shared with the webhook, so
 * running it twice, or while a webhook arrives, is safe.
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
    // orphan captures (money we could not attach to an order) are for a human to refund, never to re-apply
    where: { needsReconciliation: true, provider: "razorpay", mode: config.mode, status: { in: ["unpaid", "failed"] }, OR: [{ reconcileReason: null }, { reconcileReason: { notIn: [...ORPHAN_REASONS] } }], order: { status: "awaiting_payment", paymentMode: config.mode } },
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

// ---------------------------------------------------------------------------------------------------------------
// M10-T3: scheduled reconciliation
// ---------------------------------------------------------------------------------------------------------------

/** An awaiting-payment attempt older than this is asked about even if nothing flagged it (webhook missed, browser dropped). */
export const STALE_AWAITING_MS = 10 * 60_000;
/** A pending refund with no gateway id older than this and absent from the gateway's list is declared failed (balance released). */
export const STALE_REFUND_MS = 30 * 60_000;

export interface RefundReconcileSummary {
  checked: number;
  updated: number;
  adopted: number;
  failed: number;
  errors: number;
}

export interface GatewayReconcileSummary extends ReconcileSummary {
  swept: number;
  refunds: RefundReconcileSummary;
}

/** Flags stale unflagged attempts so the main pass looks at them. Returns how many were flagged. */
export async function sweepStaleAwaitingPayments(config: PaymentConfig, opts: { now?: Date; staleAwaitingMs?: number; limit?: number } = {}): Promise<number> {
  if (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") return 0;
  const now = opts.now ?? new Date();
  const olderThan = new Date(now.getTime() - (opts.staleAwaitingMs ?? STALE_AWAITING_MS));
  const stale = await db.payment.findMany({
    where: {
      provider: "razorpay",
      mode: config.mode,
      status: { in: ["unpaid", "failed"] },
      needsReconciliation: false,
      providerOrderId: { not: null },
      createdAt: { lt: olderThan },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: olderThan } }],
      order: { status: "awaiting_payment", paymentMode: config.mode },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
  });
  if (!stale.length) return 0;
  const r = await db.payment.updateMany({ where: { id: { in: stale.map((s) => s.id) }, needsReconciliation: false }, data: { needsReconciliation: true, reconcileReason: "stale_awaiting_payment" } });
  return r.count;
}

/**
 * Settles refunds the gateway may have processed without us hearing: pending rows get their final status, a refund
 * whose create response was lost is found by receipt, and refunds made in the dashboard are adopted into the ledger.
 */
export async function reconcileRefunds(config: PaymentConfig, opts: { now?: Date; limit?: number; gateway?: RazorpayGateway } = {}): Promise<RefundReconcileSummary> {
  const summary: RefundReconcileSummary = { checked: 0, updated: 0, adopted: 0, failed: 0, errors: 0 };
  if (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") return summary;
  const gateway = opts.gateway ?? createRazorpayProvider(config).gateway;
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_REFUND_MS);

  const pending = await db.refund.findMany({ where: { status: "pending", payment: { provider: "razorpay", mode: config.mode } }, include: { payment: true }, orderBy: { createdAt: "asc" }, take: opts.limit ?? 50 });
  for (const r of pending) {
    summary.checked++;
    try {
      const payment = r.payment;
      if (!payment.providerPaymentId) continue;
      if (r.providerRefundId) {
        const outcome = await upsertRefundFromGateway(payment, await gateway.fetchRefund(r.providerRefundId));
        if (outcome === "updated") summary.updated++;
      } else {
        const listed = await gateway.listPaymentRefunds(payment.providerPaymentId);
        const match = listed.find((g) => g.receipt === r.id);
        if (match) {
          if ((await upsertRefundFromGateway(payment, match)) === "updated") summary.updated++;
        } else if (r.createdAt < staleBefore) {
          // the gateway has no such refund after a successful lookup: nothing was refunded, release the balance
          const f = await db.refund.updateMany({ where: { id: r.id, status: "pending", providerRefundId: null }, data: { status: "failed", failureCode: "never_created_at_gateway", lastCheckedAt: now } });
          summary.failed += f.count;
        } else {
          await db.refund.update({ where: { id: r.id }, data: { lastCheckedAt: now } });
        }
      }
      await settleFullRefund(payment.id);
    } catch (e) {
      summary.errors++; // gateway unavailable: try again next run, never guess
      log.error("reconcile.refund_check_failed", { refund: r.id, reason: e instanceof GatewayError ? e.kind : "unexpected" });
    }
  }
  return summary;
}

/**
 * Audit: compare the ledger with the gateway for recently captured payments and adopt anything missing (a refund
 * made in the Razorpay dashboard while webhooks were down). Returns how many refunds were adopted.
 */
export async function auditRefunds(config: PaymentConfig, opts: { days?: number; limit?: number; now?: Date; gateway?: RazorpayGateway } = {}): Promise<{ checked: number; adopted: number; errors: number }> {
  const out = { checked: 0, adopted: 0, errors: 0 };
  if (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") return out;
  const gateway = opts.gateway ?? createRazorpayProvider(config).gateway;
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 14) * 24 * 3600_000);
  const payments = await db.payment.findMany({ where: { provider: "razorpay", mode: config.mode, providerPaymentId: { not: null }, status: { in: ["paid", "refunded"] }, updatedAt: { gt: since } }, orderBy: { updatedAt: "desc" }, take: opts.limit ?? 200 });
  for (const p of payments) {
    out.checked++;
    try {
      for (const g of await gateway.listPaymentRefunds(p.providerPaymentId!)) if ((await upsertRefundFromGateway(p, g)) === "created") out.adopted++;
      await settleFullRefund(p.id);
    } catch (e) {
      out.errors++;
      log.error("reconcile.refund_audit_failed", { reason: e instanceof GatewayError ? e.kind : "unexpected" });
    }
  }
  return out;
}

/** One scheduled cycle: flag stale payments, resolve flagged attempts, settle refunds. Counts only. */
export async function reconcileGateway(config: PaymentConfig, opts: { now?: Date; limit?: number } = {}): Promise<GatewayReconcileSummary> {
  const swept = await sweepStaleAwaitingPayments(config, opts);
  const payments = await reconcilePendingPayments(config, opts);
  const refunds = await reconcileRefunds(config, opts);
  return { ...payments, swept, refunds };
}
