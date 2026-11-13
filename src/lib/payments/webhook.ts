import "server-only";
import { Prisma, type Payment } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { errorName, log } from "@/lib/log";
import { PAYABLE_PAYMENT_STATUSES } from "@/lib/payment-verification";
import type { GatewayPayment, GatewayRefund } from "./providers/razorpay";
import { verifyWebhookSignatureWith } from "./providers/razorpay";
import { applyGatewayPayment } from "./razorpay-verify";
import { settleFullRefund, upsertRefundFromGateway, type OrphanReason } from "./refunds";

/**
 * Razorpay webhooks (M10-T1/T2/T5, ADR 0018). The signed webhook is the source of truth for payment outcomes; the
 * browser callback and reconciliation are the same logic reached by other doors, and every door is idempotent.
 *
 *  1. Authenticate: HMAC-SHA256 of the RAW body with the webhook secret (constant time). Nothing is parsed, looked
 *     up or written before the signature verifies.
 *  2. Dedupe: one `WebhookEvent` row per gateway event id. A redelivery of a processed or ignored event is a 200
 *     no-op; a failed one is processed again (the handlers below are conditional writes, so that is safe).
 *  3. Dispatch to a handler that ends in the same code paths as checkout verification (`applyGatewayPayment`,
 *     the state machine) and the refund ledger. Amount, currency and gateway order are checked against our records;
 *     anything that disagrees never marks an order paid, and a captured payment we cannot attach is recorded as an
 *     "orphan capture" so staff can refund it.
 *
 * Events can arrive in any order and more than once. Unknown or unsupported events are acknowledged (200) so the
 * gateway does not retry them forever; a database failure answers 500 so the gateway retries.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const SIGNATURE_HEADER = "x-razorpay-signature";
export const EVENT_ID_HEADER = "x-razorpay-event-id";

const envelope = z.object({ event: z.string().min(1).max(80), payload: z.record(z.string(), z.unknown()) });
const paymentEntity = z.object({ id: z.string().min(1).max(60), order_id: z.string().max(60).nullable().optional(), status: z.string().max(30), amount: z.number().int().nonnegative(), currency: z.string().max(10) });
const refundEntity = z.object({ id: z.string().min(1).max(60), payment_id: z.string().max(60).nullable().optional(), status: z.string().max(30), amount: z.number().int().nonnegative(), currency: z.string().max(10), receipt: z.string().max(60).nullable().optional() });
const wrapped = <T extends z.ZodType>(entity: T) => z.object({ entity });

export type WebhookOutcome = "paid" | "already_paid" | "payment_failed" | "failed_ignored" | "refund_recorded" | "refund_unchanged" | "orphan_recorded" | "unsupported_event" | "unknown_order" | "unknown_payment" | "mode_mismatch" | "legacy_unclassified" | "pending" | "conflict" | "ledger_mismatch";

export type WebhookResponse =
  | { status: 200; body: { ok: true; result: "processed" | "ignored" | "duplicate"; outcome?: string } }
  | { status: 400 | 413 | 500 | 503; body: { ok: false; error: string } };

const reply = (status: 400 | 413 | 500 | 503, error: string): WebhookResponse => ({ status, body: { ok: false, error } });

export interface WebhookRequest {
  rawBody: string;
  signature: string | null;
  eventId: string | null;
}

export async function handleRazorpayWebhook(req: WebhookRequest, config: PaymentConfig | null): Promise<WebhookResponse> {
  const secret = config?.razorpay?.webhookSecret;
  if (!config || (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") || !secret) return reply(503, "Webhooks are not configured");
  if (Buffer.byteLength(req.rawBody) > MAX_WEBHOOK_BYTES) return reply(413, "Payload too large");
  // 1. authenticate before anything else
  if (!verifyWebhookSignatureWith(secret, req.rawBody, req.signature)) {
    log.warn("webhook.invalid_signature", { mode: config.mode });
    return reply(400, "Invalid signature");
  }
  const eventId = req.eventId?.trim() ?? "";
  if (!eventId || eventId.length > 80) return reply(400, "Missing event id");
  let parsed: z.infer<typeof envelope>;
  try {
    const r = envelope.safeParse(JSON.parse(req.rawBody));
    if (!r.success) return reply(400, "Unexpected payload");
    parsed = r.data;
  } catch {
    return reply(400, "Invalid JSON");
  }

  // 2. dedupe
  let row = await db.webhookEvent.findUnique({ where: { provider_eventId: { provider: "razorpay", eventId } } });
  if (row && (row.status === "processed" || row.status === "ignored")) return { status: 200, body: { ok: true, result: "duplicate", outcome: row.outcome ?? undefined } };
  try {
    row = row
      ? await db.webhookEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, status: "received" } })
      : await db.webhookEvent.create({ data: { provider: "razorpay", mode: config.mode, eventId, event: parsed.event } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) return fail500(parsed.event, e);
    row = await db.webhookEvent.findUnique({ where: { provider_eventId: { provider: "razorpay", eventId } } }); // a concurrent delivery created it: process anyway, handlers are idempotent
    if (!row) return reply(500, "Could not record the event");
  }

  // 3. handle
  try {
    const outcome = await dispatch(parsed.event, parsed.payload, config);
    const ignored = outcome === "unsupported_event" || outcome === "unknown_order" || outcome === "unknown_payment";
    await db.webhookEvent.update({ where: { id: row.id }, data: { status: ignored ? "ignored" : "processed", outcome, processedAt: new Date() } });
    const level = ["conflict", "ledger_mismatch", "orphan_recorded", "mode_mismatch", "legacy_unclassified", "unknown_order", "unknown_payment"].includes(outcome) ? "warn" : "info";
    log[level]("webhook.handled", { event: parsed.event, outcome });
    return { status: 200, body: { ok: true, result: ignored ? "ignored" : "processed", outcome } };
  } catch (e) {
    await db.webhookEvent.update({ where: { id: row.id }, data: { status: "failed", outcome: "error", processedAt: new Date() } }).catch(() => undefined);
    return fail500(parsed.event, e);
  }
}

function fail500(event: string, e: unknown): WebhookResponse {
  log.error("webhook.failed", { event, reason: errorName(e) }); // never the error: it can carry payload data
  return reply(500, "Processing failed; please retry");
}

async function dispatch(event: string, payload: Record<string, unknown>, config: PaymentConfig): Promise<WebhookOutcome> {
  switch (event) {
    case "payment.captured":
    case "order.paid": {
      const p = wrapped(paymentEntity).safeParse(payload.payment);
      return p.success ? onCaptured(p.data.entity, config) : "unsupported_event";
    }
    case "payment.failed": {
      const p = wrapped(paymentEntity).safeParse(payload.payment);
      return p.success ? onFailed(p.data.entity, config) : "unsupported_event";
    }
    case "refund.created":
    case "refund.processed":
    case "refund.failed": {
      const r = wrapped(refundEntity).safeParse(payload.refund);
      return r.success ? onRefund(r.data.entity, config) : "unsupported_event";
    }
    default:
      return "unsupported_event"; // e.g. payment.authorized: acknowledged, not acted on
  }
}

type AttemptContext = { attempt: Payment; order: { id: string; number: string; status: string; paymentStatus: "unpaid" | "paid" | "failed" | "refunded"; paymentMode: string | null; total: number } };

/** Finds our payment attempt and order for a gateway payment, or says why it cannot be used. */
async function context(gp: GatewayPayment, config: PaymentConfig): Promise<AttemptContext | "unknown_order" | "mode_mismatch" | "legacy_unclassified"> {
  if (!gp.orderId) return "unknown_order";
  const attempt = await db.payment.findFirst({ where: { provider: "razorpay", providerOrderId: gp.orderId, providerPaymentId: null }, orderBy: { createdAt: "asc" } })
    ?? (await db.payment.findFirst({ where: { provider: "razorpay", providerOrderId: gp.orderId }, orderBy: { createdAt: "asc" } }));
  if (!attempt) return "unknown_order";
  const order = await db.order.findUnique({ where: { id: attempt.orderId }, select: { id: true, number: true, status: true, paymentStatus: true, paymentMode: true, total: true } });
  if (!order) return "unknown_order";
  if (order.paymentMode === null) return "legacy_unclassified";
  if (order.paymentMode !== config.mode || attempt.mode !== config.mode) return "mode_mismatch";
  return { attempt, order };
}

const toGatewayPayment = (e: z.infer<typeof paymentEntity>): GatewayPayment => ({ id: e.id, orderId: e.order_id ?? null, status: e.status, amount: e.amount, currency: e.currency });

async function onCaptured(entity: z.infer<typeof paymentEntity>, config: PaymentConfig): Promise<WebhookOutcome> {
  const gp = toGatewayPayment(entity);
  if (gp.status !== "captured") return "pending"; // order.paid carries a captured payment; anything else is not settled money
  const ctx = await context(gp, config);
  if (typeof ctx === "string") return ctx;
  const { attempt, order } = ctx;

  // this very payment is already recorded (redelivery, or checkout verification won): nothing to do
  const known = await db.payment.findUnique({ where: { providerPaymentId: gp.id } });
  if (known) return known.status === "paid" || known.status === "refunded" ? "already_paid" : "orphan_recorded";

  const payable = order.status === "awaiting_payment" && (PAYABLE_PAYMENT_STATUSES as readonly string[]).includes(order.paymentStatus);
  if (!payable) {
    // cancelled/expired before the money arrived, or already paid by another payment (customer paid twice)
    const reason: OrphanReason = order.paymentStatus === "paid" ? "duplicate_capture" : order.status === "cancelled" ? "captured_on_cancelled_order" : "captured_on_non_payable_order";
    await recordOrphanCapture(attempt, gp, reason);
    log.error("webhook.orphan_capture", { order: order.number, reason });
    return "orphan_recorded";
  }
  if (attempt.amount !== order.total || gp.amount !== attempt.amount || gp.currency !== "INR") {
    await recordOrphanCapture(attempt, gp, "amount_mismatch");
    log.error("webhook.amount_mismatch", { order: order.number });
    return "orphan_recorded";
  }
  const r = await applyGatewayPayment({ order, attempt, gp, expectedOrderId: gp.orderId! });
  switch (r.kind) {
    case "paid":
      return "paid";
    case "already_paid":
      return "already_paid";
    case "conflict":
      // lost a race or hit an invariant (e.g. payment id in use): the money is real, so keep a record a human can act on
      await recordOrphanCapture(attempt, gp, "captured_on_non_payable_order");
      return "conflict";
    default:
      return "pending";
  }
}

async function onFailed(entity: z.infer<typeof paymentEntity>, config: PaymentConfig): Promise<WebhookOutcome> {
  const gp = toGatewayPayment(entity);
  const ctx = await context(gp, config);
  if (typeof ctx === "string") return ctx;
  const { attempt, order } = ctx;
  // out of order: a failed try after a later success (or a refund) must never undo it
  if (order.paymentStatus !== "unpaid" || attempt.status !== "unpaid" || order.status !== "awaiting_payment") return "failed_ignored";
  const r = await applyGatewayPayment({ order, attempt, gp: { ...gp, status: "failed" }, expectedOrderId: gp.orderId! });
  return r.kind === "payment_failed" ? "payment_failed" : "failed_ignored";
}

async function onRefund(entity: z.infer<typeof refundEntity>, config: PaymentConfig): Promise<WebhookOutcome> {
  if (!entity.payment_id) return "unknown_payment";
  const payment = await db.payment.findUnique({ where: { providerPaymentId: entity.payment_id } });
  if (!payment || payment.provider !== "razorpay") return "unknown_payment";
  if (payment.mode !== config.mode) return "mode_mismatch";
  const gr: GatewayRefund = { id: entity.id, paymentId: entity.payment_id, amount: entity.amount, currency: entity.currency, status: entity.status, receipt: entity.receipt ?? null };
  const outcome = await upsertRefundFromGateway(payment, gr);
  await settleFullRefund(payment.id);
  return outcome === "mismatch" ? "ledger_mismatch" : outcome === "unchanged" ? "refund_unchanged" : "refund_recorded";
}

/**
 * Keep a record of a captured gateway payment that cannot be applied to its order: a `Payment` row (unique by
 * gateway payment id, so a redelivery is a no-op) with the captured amount, flagged for a human. `refunds.ts`
 * treats it as refundable; reconciliation ignores it.
 */
export async function recordOrphanCapture(attempt: Pick<Payment, "orderId" | "provider" | "mode" | "providerOrderId">, gp: GatewayPayment, reason: OrphanReason) {
  try {
    await db.payment.create({
      data: { orderId: attempt.orderId, provider: attempt.provider, mode: attempt.mode, providerOrderId: attempt.providerOrderId, providerPaymentId: gp.id, amount: gp.amount, currency: gp.currency, status: "unpaid", needsReconciliation: true, reconcileReason: reason },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
}
