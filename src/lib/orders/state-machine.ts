import { Prisma, type OrderActorType, type OrderEvent, type OrderStatus, type PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * The single place that decides order/payment status changes (M2-T2, ADR 0006).
 *
 * `transitionOrder` validates a change against the tables below, applies it with a conditional update
 * (so concurrent or stale writers lose cleanly) and appends an `OrderEvent`, all in one transaction.
 * Callers are moved onto it in M2-T5/T6; until then `tests/unit/state-machine-ratchet.test.ts` pins the
 * remaining direct writers so none can be added.
 *
 * Money is never implied by a status: nothing here confirms an offline payment automatically. Moving
 * a payment to `paid` is limited to the gateway/system actors; audited staff confirmation is M2-T6.
 */

/** Order status graph. `delivered` and `cancelled` are terminal. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_confirmation: ["confirmed", "cancelled"],
  awaiting_payment: ["paid", "cancelled"],
  confirmed: ["dispatched", "cancelled"],
  paid: ["dispatched", "cancelled"],
  dispatched: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

/** Payment status graph. `refunded` is terminal; a failed attempt may be retried. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  unpaid: ["paid", "failed"],
  failed: ["paid", "unpaid"],
  paid: ["refunded"],
  refunded: [],
};

/** Actors allowed to move a payment into each status. Unlisted targets allow every actor. */
const PAYMENT_TARGET_ACTORS: Partial<Record<PaymentStatus, readonly OrderActorType[]>> = {
  paid: ["gateway", "system"],
};

/** Actors allowed to move an order into each status. Unlisted targets allow every actor. */
const ORDER_TARGET_ACTORS: Partial<Record<OrderStatus, readonly OrderActorType[]>> = {
  paid: ["gateway", "system"],
  confirmed: ["admin", "system"],
  dispatched: ["admin", "system"],
  delivered: ["admin", "system"],
};

export const MAX_REASON_LENGTH = 500;

export interface TransitionActor {
  type: OrderActorType;
  id?: string;
}

export interface TransitionInput {
  orderId: string;
  /** The status the caller believes the order is in; the update only applies if it still is. */
  from: OrderStatus;
  /** Target status. Equal to `from` only for a payment-only change. */
  to: OrderStatus;
  /** Optional payment status change, applied atomically with the order change. */
  payment?: { from: PaymentStatus; to: PaymentStatus };
  actor: TransitionActor;
  /** Required for admin actors, cancellations and refunds. */
  reason?: string;
  /** Extra order columns written in the same conditional update (e.g. the gateway payment id). */
  data?: Pick<Prisma.OrderUpdateManyMutationInput, "razorpayPaymentId" | "razorpayOrderId">;
}

export type TransitionErrorCode = "invalid_transition" | "actor_not_allowed" | "reason_required" | "invalid_reason" | "not_found" | "stale_state";

export type TransitionFailure = { ok: false; code: TransitionErrorCode; message: string; current?: { status: OrderStatus; paymentStatus: PaymentStatus } };
export type TransitionResult = { ok: true; event: OrderEvent } | TransitionFailure;

const fail = (code: TransitionErrorCode, message: string, current?: TransitionFailure["current"]): TransitionFailure => ({ ok: false, code, message, current });

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus) => ORDER_TRANSITIONS[from]?.includes(to) ?? false;
export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus) => PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;

/** Pure validation (no I/O). Returns null when the request is allowed. */
export function validateTransition(input: Omit<TransitionInput, "orderId" | "data">): TransitionFailure | null {
  const { from, to, payment, actor, reason } = input;
  const statusChange = from !== to;
  if (!statusChange && !payment) return fail("invalid_transition", "Nothing to change");
  if (statusChange && !canTransitionOrder(from, to)) return fail("invalid_transition", `Order cannot move from ${from} to ${to}`);
  if (payment && !canTransitionPayment(payment.from, payment.to)) {
    return fail("invalid_transition", `Payment cannot move from ${payment.from} to ${payment.to}`);
  }
  if (statusChange && ORDER_TARGET_ACTORS[to] && !ORDER_TARGET_ACTORS[to]!.includes(actor.type)) {
    return fail("actor_not_allowed", `${actor.type} may not move an order to ${to}`);
  }
  if (payment && PAYMENT_TARGET_ACTORS[payment.to] && !PAYMENT_TARGET_ACTORS[payment.to]!.includes(actor.type)) {
    return fail("actor_not_allowed", `${actor.type} may not move a payment to ${payment.to}`);
  }
  const trimmed = reason?.trim();
  if (trimmed && trimmed.length > MAX_REASON_LENGTH) return fail("invalid_reason", `Reason is longer than ${MAX_REASON_LENGTH} characters`);
  const needsReason = actor.type === "admin" || to === "cancelled" || payment?.to === "refunded";
  if (needsReason && !trimmed) return fail("reason_required", "A reason is required for this change");
  return null;
}

/**
 * Apply a validated transition atomically. Never throws for expected outcomes; database failures propagate.
 * The conditional `updateMany` is the concurrency guard: if another writer changed the order first, no
 * row matches, nothing is written, and the caller gets `stale_state` with the order's current statuses.
 */
export async function transitionOrder(input: TransitionInput): Promise<TransitionResult> {
  const invalid = validateTransition(input);
  if (invalid) return invalid;

  const { orderId, from, to, payment, actor, data } = input;
  const reason = input.reason?.trim() || null;

  return db.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: from, ...(payment ? { paymentStatus: payment.from } : {}) },
      data: { status: to, ...(payment ? { paymentStatus: payment.to } : {}), ...data },
    });
    if (updated.count === 0) {
      const current = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, paymentStatus: true } });
      return current ? fail("stale_state", "Order changed since it was read", current) : fail("not_found", "Order not found");
    }
    const event = await tx.orderEvent.create({
      data: {
        orderId,
        fromStatus: from,
        toStatus: to,
        fromPaymentStatus: payment?.from ?? null,
        toPaymentStatus: payment?.to ?? null,
        actorType: actor.type,
        actorId: actor.id ?? null,
        reason,
      },
    });
    return { ok: true as const, event };
  });
}
