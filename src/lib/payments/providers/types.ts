import type { PaymentMode, PaymentProvider as PaymentProviderId } from "@prisma/client";

/** Pure types (no I/O) shared by every payment provider. Amounts are integer paise. */
export interface CreatePaymentRequest {
  /** Human order number; used as the gateway receipt. */
  orderNumber: string;
  amountPaise: number;
  currency: "INR";
}

/** What a provider hands back when it starts a payment. Persisted as a `Payment` row by the caller. */
export interface ProviderPayment {
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  /** Exactly the object the browser needs (same shape the checkout response already uses for Razorpay). */
  clientPayload: Record<string, string | number | boolean>;
}

export interface PaymentProof {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** The PAYMENT_MODE this provider instance was created under; stored on every `Payment` row. */
  readonly mode: PaymentMode;
  /** True when the customer pays through a hosted checkout during the order request. */
  readonly online: boolean;
  /** Set for providers whose payments are not real money; surfaces must show it (M2-T4). */
  readonly label: string | null;
  /**
   * Start a payment. Returns null when this provider takes no payment at order time
   * (request-only: payment stays pending until externally confirmed).
   */
  createPayment(req: CreatePaymentRequest): Promise<ProviderPayment | null>;
  /**
   * Check a payment proof. Constant-time; never throws on bad input. A provider that cannot verify
   * anything (request-only) always returns false, so no code path can confirm a payment through it.
   */
  verifyPayment(proof: PaymentProof): boolean;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
