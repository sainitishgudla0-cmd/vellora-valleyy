import type { PaymentConfig } from "@/lib/env/payment-config";
import { createMockProvider } from "./mock";
import { createRazorpayProvider } from "./razorpay";
import { createRequestOnlyProvider } from "./request-only";
import type { PaymentProvider } from "./types";

/**
 * Select the provider for a resolved payment configuration (ADR 0002). Selection is purely a function of
 * `config.mode`; environment rules live in `resolvePaymentConfig` and are not repeated here.
 */
export function providerForConfig(config: PaymentConfig): PaymentProvider {
  switch (config.mode) {
    case "mock":
      return createMockProvider(config);
    case "razorpay_test":
    case "razorpay_live":
      return createRazorpayProvider(config);
    case "request_only":
      return createRequestOnlyProvider();
  }
}

export type { PaymentProvider, PaymentProof, CreatePaymentRequest, ProviderPayment } from "./types";
export { ProviderUnavailableError } from "./types";
