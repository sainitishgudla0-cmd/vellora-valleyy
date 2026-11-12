import "server-only";
import { PaymentConfigError, resolvePaymentConfig, type PaymentConfig } from "./env/payment-config";
import { providerForConfig, type PaymentProvider } from "./payments/providers";
import { createRazorpayOrder as rpCreateOrder, verifyRazorpaySignatureWith } from "./payments/providers/razorpay";

/**
 * Payments facade: configuration plus the providers in ./payments/providers (request_only, mock, razorpay).
 * Razorpay is optional. Online payment is only offered when PAYMENT_MODE is
 * razorpay_test / razorpay_live AND the configuration passes validation (src/lib/env/payment-config.ts).
 * An invalid configuration fails closed: online payments are disabled and the error is logged.
 * Nothing here ever marks an order paid without a verified Razorpay signature.
 */
let lastLoggedError = "";

export function safePaymentConfig(): PaymentConfig | null {
  try {
    return resolvePaymentConfig();
  } catch (e) {
    const msg = e instanceof PaymentConfigError ? e.message : String(e);
    if (msg !== lastLoggedError) {
      lastLoggedError = msg;
      console.error(`[payments] ${msg} Online payments are disabled.`);
    }
    return null;
  }
}

export function razorpayConfig() {
  return safePaymentConfig()?.razorpay ?? null;
}

export const onlinePaymentsEnabled = () => safePaymentConfig()?.onlinePayments === true;

/** The provider for the current PAYMENT_MODE, or null when the configuration is invalid (fails closed). */
export function currentPaymentProvider(): PaymentProvider | null {
  const cfg = safePaymentConfig();
  return cfg ? providerForConfig(cfg) : null;
}

// Backwards-compatible helpers used by the existing routes (moved onto providers in M2-T5).
export async function createRazorpayOrder(amountPaise: number, receipt: string) {
  const cfg = razorpayConfig();
  if (!cfg) throw new Error("Online payments are not configured");
  return rpCreateOrder(cfg, amountPaise, receipt);
}

export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string) {
  const cfg = razorpayConfig();
  if (!cfg) return false;
  return verifyRazorpaySignatureWith(cfg.keySecret, orderId, paymentId, signature);
}
