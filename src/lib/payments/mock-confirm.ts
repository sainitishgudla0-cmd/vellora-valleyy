import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { transitionOrder } from "@/lib/orders/state-machine";
import { safeEqual } from "@/lib/payment-verification";
import { createMockProvider, mockProviderPaymentId } from "./providers/mock";

/**
 * Simulated payment confirmation for development/test (M2-T4, ADR 0008). Nothing here is evidence of
 * financial settlement: the mock provider's identifiers and signature are deterministic simulation tools.
 *
 * Authorisation is the caller's job (the route checks mode, environment, a dev/test confirm key and
 * rate limits); this function additionally requires the customer's order access token and that the order
 * and a matching payment attempt were *created as mock* on the server. The Payment row and the order
 * transition (+ OrderEvent) are written in one PostgreSQL transaction via the M2-T2 state machine.
 */
export interface MockConfirmInput {
  orderNumber: string;
  token: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export type MockConfirmConflict = "different_payment" | "amount_mismatch" | "order_not_payable" | "stale";

export type MockConfirmResult =
  | { kind: "confirmed" }
  | { kind: "already_confirmed" }
  | { kind: "not_found" }
  | { kind: "invalid_proof" }
  | { kind: "conflict"; reason: MockConfirmConflict };

/** Thrown inside the transaction to roll back every write, carrying the outcome to report. */
class Abort extends Error {
  constructor(public result: MockConfirmResult) {
    super("mock confirm aborted");
  }
}

const SIMULATION_REASON = "Simulated mock payment: no money moved";

export async function confirmMockPayment(input: MockConfirmInput, config: Pick<PaymentConfig, "mode" | "appEnv">): Promise<MockConfirmResult> {
  const provider = createMockProvider(config); // throws unless mode=mock in development/test

  const order = await db.order.findUnique({
    where: { number: input.orderNumber },
    select: { id: true, accessToken: true, status: true, paymentStatus: true, paymentMode: true, total: true },
  });
  // unknown order, wrong token, and any order not created as mock (request-only, Razorpay, legacy NULL) look identical
  if (!order || !safeEqual(input.token, order.accessToken) || order.paymentMode !== "mock") return { kind: "not_found" };

  const attempt = await db.payment.findFirst({
    where: { orderId: order.id, providerOrderId: input.providerOrderId, provider: "mock", mode: "mock" },
  });
  if (!attempt) return { kind: "not_found" };

  const proofOk =
    input.providerPaymentId === mockProviderPaymentId(input.providerOrderId) &&
    provider.verifyPayment({ providerOrderId: input.providerOrderId, providerPaymentId: input.providerPaymentId, signature: input.signature });
  if (!proofOk) return { kind: "invalid_proof" };

  // The Payment row and the order change commit atomically, so a paid attempt means the order is paid too.
  // (The two reads above are not one snapshot: never infer "inconsistent" from a paid attempt + a stale order read.)
  if (attempt.status === "paid") {
    return attempt.providerPaymentId === input.providerPaymentId ? { kind: "already_confirmed" } : { kind: "conflict", reason: "different_payment" };
  }
  if (order.paymentStatus === "paid") return { kind: "conflict", reason: "different_payment" };
  if (attempt.amount !== order.total || attempt.currency !== "INR") return { kind: "conflict", reason: "amount_mismatch" };
  if (order.status !== "awaiting_payment" || order.paymentStatus !== "unpaid") return { kind: "conflict", reason: "order_not_payable" };

  try {
    await db.$transaction(async (tx) => {
      // conditional write: only an unpaid, unclaimed mock attempt with the server-recorded amount can be paid
      const claimed = await tx.payment.updateMany({
        where: { id: attempt.id, status: "unpaid", provider: "mock", mode: "mock", amount: order.total, currency: "INR", providerPaymentId: null },
        data: { status: "paid", providerPaymentId: input.providerPaymentId },
      });
      if (claimed.count === 0) throw new Abort({ kind: "conflict", reason: "stale" });

      const moved = await transitionOrder(
        {
          orderId: order.id,
          from: "awaiting_payment",
          to: "paid",
          payment: { from: "unpaid", to: "paid" },
          actor: { type: "system", id: "mock-provider" },
          reason: SIMULATION_REASON,
        },
        tx,
      );
      if (!moved.ok) throw new Abort({ kind: "conflict", reason: moved.code === "stale_state" ? "order_not_payable" : "stale" });
    });
    return { kind: "confirmed" };
  } catch (e) {
    if (e instanceof Abort) {
      // a concurrent identical confirmation may have won: report it as the idempotent success it is
      const [a, o] = await Promise.all([db.payment.findUnique({ where: { id: attempt.id } }), db.order.findUnique({ where: { id: order.id }, select: { paymentStatus: true } })]);
      if (a && o && a.status === "paid" && a.providerPaymentId === input.providerPaymentId && o.paymentStatus === "paid") return { kind: "already_confirmed" };
      return e.result;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { kind: "conflict", reason: "different_payment" };
    throw e;
  }
}
