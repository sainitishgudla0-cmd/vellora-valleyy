import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { PaymentProvider, ProviderPayment } from "./providers/types";

type Client = Pick<typeof db, "payment">;

/**
 * Persist one payment attempt for an order. Writes only the `Payment` row: order/payment *status* changes
 * go through `transitionOrder` (M2-T5 wires the routes). `providerPaymentId` is unique, so a gateway payment
 * can be attached to at most one attempt.
 */
export function recordPaymentAttempt(
  provider: Pick<PaymentProvider, "id" | "mode">,
  orderId: string,
  payment: Pick<ProviderPayment, "providerOrderId" | "amountPaise" | "currency"> | { providerOrderId?: undefined; amountPaise: number; currency: string },
  client: Client = db,
) {
  if (!Number.isInteger(payment.amountPaise) || payment.amountPaise <= 0) throw new RangeError("Payment amount must be a positive integer number of paise");
  const data: Prisma.PaymentUncheckedCreateInput = {
    orderId,
    provider: provider.id,
    mode: provider.mode,
    providerOrderId: payment.providerOrderId ?? null,
    amount: payment.amountPaise,
    currency: payment.currency,
    status: "unpaid",
  };
  return client.payment.create({ data });
}
