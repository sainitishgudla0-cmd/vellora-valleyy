import crypto from "node:crypto";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { ProviderUnavailableError, type PaymentProvider } from "./types";

/**
 * Mock provider: no network, no money. Exists so the whole flow can be exercised in development/test.
 * `resolvePaymentConfig` already rejects PAYMENT_MODE=mock outside development/test (ADR 0002); the
 * checks below are a second, independent barrier so a mis-wired caller still cannot build one.
 */
const MOCK_ENVS = new Set(["development", "test"]);
export { MOCK_PAYMENT_LABEL as MOCK_LABEL } from "../labels";
import { MOCK_PAYMENT_LABEL } from "../labels";

/** Not a secret: the mock is unreachable outside development/test. It only keeps the proof shape realistic. */
const mockSignature = (providerOrderId: string, providerPaymentId: string) =>
  crypto.createHmac("sha256", "velora-mock-provider").update(`${providerOrderId}|${providerPaymentId}`).digest("hex");

export const mockProviderOrderId = (orderNumber: string) => `mock_order_${orderNumber}`;
export const mockProviderPaymentId = (providerOrderId: string) => `mock_pay_${providerOrderId.replace(/^mock_order_/, "")}`;
export const mockProof = (providerOrderId: string) => {
  const providerPaymentId = mockProviderPaymentId(providerOrderId);
  return { providerOrderId, providerPaymentId, signature: mockSignature(providerOrderId, providerPaymentId) };
};

export function createMockProvider(config: Pick<PaymentConfig, "mode" | "appEnv">): PaymentProvider {
  if (config.mode !== "mock") throw new ProviderUnavailableError("The mock payment provider requires PAYMENT_MODE=mock.");
  if (!MOCK_ENVS.has(config.appEnv)) throw new ProviderUnavailableError(`The mock payment provider is unavailable when APP_ENV=${config.appEnv}.`);
  return {
    id: "mock",
    mode: "mock",
    online: true,
    label: MOCK_PAYMENT_LABEL,
    async createPayment(req) {
      const providerOrderId = mockProviderOrderId(req.orderNumber);
      return {
        providerOrderId,
        amountPaise: req.amountPaise,
        currency: req.currency,
        // explicitly simulated; never contains the confirm key or the proof signature
        clientPayload: { provider: "mock", orderId: providerOrderId, amount: req.amountPaise, currency: req.currency, mock: true, label: MOCK_PAYMENT_LABEL },
      };
    },
    verifyPayment(proof) {
      const a = Buffer.from(mockSignature(proof.providerOrderId, proof.providerPaymentId));
      const b = Buffer.from(String(proof.signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}
