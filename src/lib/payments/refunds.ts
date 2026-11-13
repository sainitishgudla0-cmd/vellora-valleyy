import "server-only";
import { Prisma, type Refund, type RefundStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { errorName, log } from "@/lib/log";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { transitionOrder } from "@/lib/orders/state-machine";
import { createRazorpayProvider, GatewayError, type GatewayRefund } from "./providers/razorpay";

/**
 * Refund ledger and service (M10-T4, ADR 0018). Money returned to customers is recorded in `Refund` rows (integer
 * paise). A pending or processed row counts against the payment's refundable balance, a failed row releases it.
 *
 * Three writers share this module and the same conditional rules, so they can run in any order or twice:
 *  - `createRefund`: an authorised admin asks for a full or partial refund. The ledger row is committed (under a
 *    row lock on the payment) BEFORE the gateway call, so a crash or lost response can never lose track of a refund
 *    that may have happened. The row's id is sent to the gateway as the receipt, which is how an unknown outcome is
 *    matched later.
 *  - `upsertRefundFromGateway`: a webhook, a reconciliation pass or the audit reports what the gateway holds.
 *    A refund made in the Razorpay dashboard is adopted as a `gateway` row, so the ledger always matches the gateway.
 *  - `settleFullRefund`: when processed refunds add up to the whole payment the payment (and the order's payment
 *    status) moves `paid -> refunded` through the state machine. Partial refunds leave the payment `paid`.
 */

/** Why a captured gateway payment is not attached to a payable order (a human must refund it or decide). */
export const ORPHAN_REASONS = ["captured_on_cancelled_order", "captured_on_non_payable_order", "duplicate_capture", "amount_mismatch"] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];

export const MAX_REFUND_REASON = 500;

export interface RefundView {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: RefundStatus;
  source: "admin" | "gateway";
  failureCode: string | null;
  createdAt: Date;
}

const view = (r: Refund): RefundView => ({ id: r.id, paymentId: r.paymentId, amountPaise: r.amount, status: r.status, source: r.source, failureCode: r.failureCode, createdAt: r.createdAt });

const isOrphan = (reason: string | null): boolean => !!reason && (ORPHAN_REASONS as readonly string[]).includes(reason);

/** A payment the gateway captured and we have not yet refunded in full: paid, or recorded as an orphan capture. */
export function isRefundablePayment(p: { status: string; providerPaymentId: string | null; reconcileReason: string | null }): boolean {
  if (!p.providerPaymentId) return false;
  return p.status === "paid" || (p.status === "unpaid" && isOrphan(p.reconcileReason));
}

const mapStatus = (s: string): RefundStatus => (s === "processed" ? "processed" : s === "failed" ? "failed" : "pending");

/** Sum of refunds that hold balance (pending + processed). */
async function reservedAmount(client: Pick<typeof db, "refund">, paymentId: string): Promise<number> {
  const r = await client.refund.aggregate({ where: { paymentId, status: { in: ["pending", "processed"] } }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

/** Refundable balance of a payment in paise (0 when it is not a refundable payment). */
export async function refundableBalance(paymentId: string): Promise<number> {
  const p = await db.payment.findUnique({ where: { id: paymentId } });
  if (!p || !isRefundablePayment(p)) return 0;
  return Math.max(0, p.amount - (await reservedAmount(db, paymentId)));
}

class Abort extends Error {}

/**
 * When processed refunds cover the whole payment, mark the payment `refunded` (and the order's payment status,
 * through the state machine). Idempotent; returns true when the payment is (now) fully refunded.
 */
export async function settleFullRefund(paymentId: string): Promise<boolean> {
  const p = await db.payment.findUnique({ where: { id: paymentId } });
  if (!p) return false;
  if (p.status === "refunded") return true;
  if (!isRefundablePayment(p)) return false;
  const processed = await db.refund.aggregate({ where: { paymentId, status: "processed" }, _sum: { amount: true } });
  if ((processed._sum.amount ?? 0) < p.amount) return false;
  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({ where: { id: p.id, status: p.status }, data: { status: "refunded", needsReconciliation: false, reconcileReason: null, lastCheckedAt: new Date() } });
      if (claimed.count === 0) throw new Abort();
      if (p.status !== "paid") return; // an orphan capture: the order's own payment status was never `paid`
      const order = await tx.order.findUnique({ where: { id: p.orderId }, select: { status: true, paymentStatus: true } });
      if (order?.paymentStatus !== "paid") return; // the order records another payment (or was settled by hand): leave it
      const moved = await transitionOrder(
        { orderId: p.orderId, from: order.status, to: order.status, payment: { from: "paid", to: "refunded" }, actor: { type: "gateway", id: "razorpay" }, reason: "The whole payment was refunded at the gateway" },
        tx,
      );
      if (!moved.ok) throw new Abort();
    });
    return true;
  } catch (e) {
    if (e instanceof Abort) return (await db.payment.findUnique({ where: { id: p.id }, select: { status: true } }))?.status === "refunded"; // a concurrent settle may have won
    throw e;
  }
}

export type UpsertOutcome = "created" | "updated" | "unchanged" | "mismatch";

/**
 * Reflect one gateway refund in the ledger. Matches by gateway refund id, else by receipt (our row id, for a refund
 * whose response we never saw), else adopts it as a `gateway` row. Pending -> processed|failed only moves forward,
 * so out-of-order or repeated events change nothing. A gateway refund we marked failed by guesswork is re-opened.
 */
export async function upsertRefundFromGateway(payment: { id: string; orderId: string; amount: number }, gr: GatewayRefund): Promise<UpsertOutcome> {
  if (gr.currency !== "INR" || !Number.isInteger(gr.amount) || gr.amount <= 0) {
    log.error("refunds.gateway_refund_unusable", { reason: "currency_or_amount" });
    return "mismatch";
  }
  const status = mapStatus(gr.status);
  let row = await db.refund.findUnique({ where: { providerRefundId: gr.id } });
  if (!row && gr.receipt) row = await db.refund.findFirst({ where: { id: gr.receipt, paymentId: payment.id, providerRefundId: null } });
  if (!row) {
    try {
      await db.refund.create({ data: { orderId: payment.orderId, paymentId: payment.id, amount: gr.amount, status, source: "gateway", providerRefundId: gr.id, reason: "Refund recorded from the payment gateway", failureCode: status === "failed" ? "gateway_failed" : null, lastCheckedAt: new Date() } });
      return "created";
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "unchanged"; // a concurrent delivery recorded it
      throw e;
    }
  }
  if (row.paymentId !== payment.id || row.amount !== gr.amount) {
    log.error("refunds.ledger_mismatch", { refund: row.id, reason: row.paymentId !== payment.id ? "payment" : "amount" });
    return "mismatch";
  }
  const guessedFailed = row.status === "failed" && !row.providerRefundId; // we gave up waiting; the gateway proves otherwise
  const advances = row.status === "pending" ? status !== "pending" || row.providerRefundId !== gr.id : guessedFailed && status !== "failed";
  if (!advances) return "unchanged";
  const r = await db.refund.updateMany({
    where: { id: row.id, status: row.status, providerRefundId: row.providerRefundId },
    data: { providerRefundId: gr.id, status, failureCode: status === "failed" ? "gateway_failed" : null, lastCheckedAt: new Date() },
  });
  return r.count === 1 ? "updated" : "unchanged";
}

// ---------------------------------------------------------------------------------------------------------------
// Admin service
// ---------------------------------------------------------------------------------------------------------------

export interface CreateRefundInput {
  orderId: string;
  /** Paise. Omitted = the whole remaining balance. */
  amountPaise?: number;
  reason: string;
  /** Idempotency key: replaying it returns the same refund and never refunds twice. */
  requestKey: string;
  /** Needed only when the order has several captured payments (e.g. a duplicate capture). */
  paymentId?: string;
  adminId: string;
}

export type RefundErrorCode = "not_found" | "unavailable" | "not_refundable" | "exceeds_refundable" | "fully_refunded" | "key_reused" | "gateway_rejected" | "gateway_unknown";

export type RefundResult = { ok: true; refund: RefundView; replayed: boolean } | { ok: false; code: RefundErrorCode; message: string; remaining?: number; refund?: RefundView };

const no = (code: RefundErrorCode, message: string, extra: { remaining?: number; refund?: RefundView } = {}): RefundResult => ({ ok: false, code, message, ...extra });

export async function createRefund(input: CreateRefundInput, config: PaymentConfig | null): Promise<RefundResult> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, select: { id: true, number: true } });
  if (!order) return no("not_found", "Order not found");
  if (!config || (config.mode !== "razorpay_test" && config.mode !== "razorpay_live")) return no("unavailable", "Online refunds are not available in this environment");

  const candidates = await db.payment.findMany({
    where: { orderId: order.id, provider: "razorpay", mode: config.mode, ...(input.paymentId ? { id: input.paymentId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  const refundable = candidates.filter(isRefundablePayment);
  // an already fully refunded payment is a replay or a mistake, never a new refund
  const target = input.paymentId ? refundable[0] : refundable.length === 1 ? refundable[0] : refundable.find((p) => p.status === "paid");
  if (!target) {
    const replay = await findReplay(candidates.map((c) => c.id), input.requestKey);
    if (replay) return replayResult(replay, input);
    return no("not_refundable", candidates.some((c) => c.status === "refunded") ? "This payment has already been refunded in full" : "This order has no captured online payment to refund");
  }
  if (!input.paymentId && refundable.filter((p) => p.status === "paid").length === 0 && refundable.length > 1) return no("not_refundable", "Several captured payments exist; choose which one to refund");

  // 1. Reserve the amount under a row lock and commit the ledger row before any money moves.
  let refund: Refund;
  try {
    const reserved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${target.id} FOR UPDATE`;
      const existing = await tx.refund.findUnique({ where: { paymentId_requestKey: { paymentId: target.id, requestKey: input.requestKey } } });
      if (existing) return { existing };
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: target.id } });
      if (!isRefundablePayment(fresh)) throw new Abort();
      const balance = fresh.amount - (await reservedAmount(tx, fresh.id));
      if (balance <= 0) return { blocked: no("fully_refunded", "The whole payment is already refunded or being refunded", { remaining: 0 }) };
      const amount = input.amountPaise ?? balance;
      if (!Number.isInteger(amount) || amount <= 0) return { blocked: no("exceeds_refundable", "Refund amount must be a positive whole number of paise", { remaining: balance }) };
      if (amount > balance) return { blocked: no("exceeds_refundable", "The amount is more than the refundable balance", { remaining: balance }) };
      const created = await tx.refund.create({ data: { orderId: order.id, paymentId: fresh.id, amount, currency: "INR", status: "pending", source: "admin", reason: input.reason.trim(), requestedBy: input.adminId, requestKey: input.requestKey } });
      return { created };
    });
    if ("blocked" in reserved && reserved.blocked) return reserved.blocked;
    if ("existing" in reserved && reserved.existing) return replayResult(reserved.existing, input);
    refund = (reserved as { created: Refund }).created;
  } catch (e) {
    if (e instanceof Abort) return no("not_refundable", "This payment can no longer be refunded");
    throw e;
  }

  // 2. Ask the gateway. The receipt is our row id, so a lost response is matched by reconciliation.
  const provider = createRazorpayProvider(config);
  let gr: GatewayRefund;
  try {
    gr = await provider.gateway.createRefund(target.providerPaymentId!, refund.amount, refund.id);
    if (gr.amount !== refund.amount || gr.currency !== "INR" || (gr.paymentId && gr.paymentId !== target.providerPaymentId)) throw new GatewayError("invalid_response", "Gateway refund does not match the request");
  } catch (e) {
    if (e instanceof GatewayError && (e.kind === "rejected" || e.kind === "not_found")) {
      // definite: nothing was refunded, release the balance
      const failed = await markFailed(refund.id, e.kind === "rejected" ? "gateway_rejected" : "payment_not_found");
      log.error("refunds.gateway_rejected", { refund: refund.id, reason: e.kind });
      return no("gateway_rejected", "The payment gateway refused this refund. Nothing was refunded.", { refund: view(failed) });
    }
    // unknown outcome (timeout, 5xx, bad body): the row stays pending and is resolved by reconciliation, never retried blindly
    log.error("refunds.gateway_outcome_unknown", { refund: refund.id, reason: e instanceof GatewayError ? e.kind : errorName(e) });
    const flagged = await db.refund.update({ where: { id: refund.id }, data: { failureCode: "outcome_unknown", lastCheckedAt: new Date() } });
    return no("gateway_unknown", "The payment gateway did not confirm the refund. It may still be processed; do not retry. It will be checked automatically.", { refund: view(flagged) });
  }

  // 3. Record what the gateway said (a webhook may already have done so: the update is conditional and idempotent).
  const status = mapStatus(gr.status);
  try {
    await db.refund.updateMany({ where: { id: refund.id, OR: [{ providerRefundId: null }, { providerRefundId: gr.id }] }, data: { providerRefundId: gr.id, status: status === "pending" ? undefined : status, failureCode: status === "failed" ? "gateway_failed" : null, lastCheckedAt: new Date() } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; // the webhook adopted it as its own row first: the ledger still has the refund
    log.warn("refunds.duplicate_gateway_row", { refund: refund.id });
  }
  await settleFullRefund(target.id);
  const final = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
  return { ok: true, refund: view(final), replayed: false };
}

async function markFailed(id: string, code: string): Promise<Refund> {
  await db.refund.updateMany({ where: { id, status: "pending", providerRefundId: null }, data: { status: "failed", failureCode: code, lastCheckedAt: new Date() } });
  return db.refund.findUniqueOrThrow({ where: { id } });
}

async function findReplay(paymentIds: string[], requestKey: string): Promise<Refund | null> {
  if (!paymentIds.length) return null;
  return db.refund.findFirst({ where: { paymentId: { in: paymentIds }, requestKey } });
}

function replayResult(existing: Refund, input: CreateRefundInput): RefundResult {
  // the same key with a different amount is a client bug, not a retry
  if (input.amountPaise !== undefined && input.amountPaise !== existing.amount) return no("key_reused", "This request key was already used for a different refund");
  return { ok: true, refund: view(existing), replayed: true };
}

export interface OrderRefunds {
  refunds: RefundView[];
  payments: { paymentId: string; amountPaise: number; refundedPaise: number; refundablePaise: number; status: string }[];
}

/** Ledger and balances for one order (admin read). */
export async function listOrderRefunds(orderId: string): Promise<OrderRefunds | null> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) return null;
  const [refunds, payments] = await Promise.all([
    db.refund.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    db.payment.findMany({ where: { orderId, provider: "razorpay" }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    refunds: refunds.map(view),
    payments: payments
      .filter((p) => p.providerPaymentId && (isRefundablePayment(p) || p.status === "refunded"))
      .map((p) => {
        const mine = refunds.filter((r) => r.paymentId === p.id);
        const reserved = mine.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amount, 0);
        return { paymentId: p.id, amountPaise: p.amount, refundedPaise: mine.filter((r) => r.status === "processed").reduce((n, r) => n + r.amount, 0), refundablePaise: isRefundablePayment(p) ? Math.max(0, p.amount - reserved) : 0, status: p.status };
      }),
  };
}
