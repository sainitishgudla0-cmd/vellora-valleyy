import "server-only";
import { Prisma, type OrderStatus, type PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { transitionOrder, validateTransition, type TransitionErrorCode } from "./state-machine";

/**
 * Admin changes to an order's status and payment (M2-T6, ADR 0010). Everything goes through `transitionOrder`
 * (transitions, actor rules, reasons, event history); this service adds what depends on the order's payment
 * mode and keeps the `Payment` row in step in the same transaction.
 *
 * Admin payment edits are deliberately narrow:
 *  - unpaid -> paid: only for request-only orders (pay on delivery), with a reason and an external payment
 *    reference. Gateway and mock payments are confirmed by their providers, never by hand.
 *  - paid -> refunded: bookkeeping that a refund was made outside the system (real refunds are M10), with a reason.
 *  Anything else is refused. Orders without a recorded mode (legacy) or without a payment record cannot have
 *  their payment edited here: they need operator reconciliation.
 */
export interface AdminOrderUpdate {
  orderId: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  reason?: string;
  paymentReference?: string;
  adminId?: string;
}

export type AdminUpdateCode = TransitionErrorCode | "payment_edit_not_allowed" | "no_payment_record" | "reference_in_use";

export type AdminUpdateResult = { ok: true; changed: boolean } | { ok: false; code: AdminUpdateCode | "not_found"; message: string };

const DEFAULT_REASON = "Status changed from the admin dashboard";

class Abort extends Error {
  constructor(public result: AdminUpdateResult) {
    super("admin update aborted");
  }
}
const no = (code: AdminUpdateCode | "not_found", message: string): AdminUpdateResult => ({ ok: false, code, message });

export async function updateOrderAsAdmin(input: AdminOrderUpdate): Promise<AdminUpdateResult> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, select: { id: true, status: true, paymentStatus: true, paymentMode: true } });
  if (!order) return no("not_found", "Order not found");

  const statusChange = input.status !== undefined && input.status !== order.status;
  const paymentChange = input.paymentStatus !== undefined && input.paymentStatus !== order.paymentStatus;
  if (!statusChange && !paymentChange) return { ok: true, changed: false }; // idempotent no-op

  const to = statusChange ? input.status! : order.status;
  const explicitReason = input.reason?.trim() || undefined;
  // Plain status moves from the dashboard get a recorded default reason. Payment edits, and cancelling an order
  // that has been paid (a refund follows), need a human-written one.
  const needsExplicit = paymentChange || (to === "cancelled" && order.paymentStatus === "paid");
  const reason = explicitReason ?? (needsExplicit ? undefined : DEFAULT_REASON);
  const adminId = input.adminId ?? "admin";

  try {
    await db.$transaction(async (tx) => {
      let payment: { from: PaymentStatus; to: PaymentStatus } | undefined;
      if (paymentChange) {
        const target = input.paymentStatus!;
        const manualConfirm = order.paymentStatus === "unpaid" && target === "paid";
        const refund = order.paymentStatus === "paid" && target === "refunded";
        if (!manualConfirm && !refund) throw new Abort(no("payment_edit_not_allowed", `A payment cannot be moved from ${order.paymentStatus} to ${target} by hand`));
        if (order.paymentMode === null || order.paymentMode === "mock") {
          throw new Abort(no("payment_edit_not_allowed", order.paymentMode === null ? "This order predates payment-mode tracking; reconcile its payment manually" : "Mock payments cannot be edited"));
        }
        if (manualConfirm && order.paymentMode !== "request_only") throw new Abort(no("payment_edit_not_allowed", "Online payments are confirmed by the payment provider, not by hand"));

        const attempt = await tx.payment.findFirst({ where: { orderId: order.id, status: order.paymentStatus }, orderBy: { createdAt: "desc" } });
        if (!attempt) throw new Abort(no("no_payment_record", "This order has no payment record to update"));
        if (manualConfirm && attempt.provider !== "request_only") throw new Abort(no("payment_edit_not_allowed", "Online payments are confirmed by the payment provider, not by hand"));

        // Validate reason/reference (and the transition) before touching the Payment row.
        const invalid = validateTransition({ from: order.status, to, payment: { from: order.paymentStatus, to: target }, actor: { type: "admin", id: adminId }, reason, paymentReference: input.paymentReference });
        if (invalid) throw new Abort(no(invalid.code, invalid.message));

        const claimed = await tx.payment.updateMany({
          where: { id: attempt.id, status: order.paymentStatus },
          data: { status: target, ...(manualConfirm ? { manualReference: input.paymentReference?.trim() } : {}) },
        });
        if (claimed.count === 0) throw new Abort(no("stale_state", "The payment changed since it was read"));
        payment = { from: order.paymentStatus, to: target };
      }

      const moved = await transitionOrder(
        { orderId: order.id, from: order.status, to, payment, actor: { type: "admin", id: adminId }, reason, paymentReference: input.paymentReference },
        tx,
      );
      if (!moved.ok) throw new Abort(no(moved.code, moved.message));
    });
    return { ok: true, changed: true };
  } catch (e) {
    if (e instanceof Abort) return e.result;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return no("reference_in_use", "That payment reference is already recorded against another order");
    throw e;
  }
}
