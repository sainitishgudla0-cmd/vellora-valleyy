import type { PaymentMethod, PaymentMode } from "@prisma/client";
import type { PaymentConfig } from "@/lib/env/payment-config";

/**
 * The `Order.paymentMode` for a new order, derived only from the server-resolved payment configuration and
 * the validated payment method (never from a client-supplied mode). It names the provider that handles the
 * order: pay-on-delivery never touches a gateway, so it is `request_only` whatever the global mode is.
 * Returns null when no consistent mode exists (e.g. an online order while online payments are off).
 * Pure; the database CHECK constraints enforce the same pairing.
 */
export function resolveOrderPaymentMode(method: PaymentMethod, config: Pick<PaymentConfig, "mode"> | null): PaymentMode | null {
  if (method === "cod") return "request_only";
  if (!config) return null;
  return config.mode === "mock" || config.mode === "razorpay_test" || config.mode === "razorpay_live" ? config.mode : null;
}
