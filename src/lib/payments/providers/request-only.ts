import type { PaymentProvider } from "./types";

/**
 * Pay-on-delivery / order-request flow. Takes no payment at order time and can never verify one:
 * the order stays unpaid until it is externally confirmed (staff confirmation is audited in M2-T6).
 * There is deliberately no automatic offline-payment confirmation here.
 */
export function createRequestOnlyProvider(): PaymentProvider {
  return {
    id: "request_only",
    mode: "request_only",
    online: false,
    label: null,
    async createPayment() {
      return null;
    },
    verifyPayment() {
      return false;
    },
  };
}
