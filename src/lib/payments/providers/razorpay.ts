import crypto from "node:crypto";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { ProviderUnavailableError, type PaymentProvider } from "./types";

/** Razorpay Orders API + signature check. Moved verbatim from the former payments.ts (behaviour unchanged). */
export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
}

export async function createRazorpayOrder(keys: RazorpayKeys, amountPaise: number, receipt: string) {
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64"),
    },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Razorpay order creation failed (${res.status})`);
  return (await res.json()) as { id: string; amount: number; currency: string };
}

export function verifyRazorpaySignatureWith(keySecret: string, orderId: string, paymentId: string, signature: string) {
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createRazorpayProvider(config: Pick<PaymentConfig, "mode" | "razorpay">): PaymentProvider {
  if ((config.mode !== "razorpay_test" && config.mode !== "razorpay_live") || !config.razorpay) {
    throw new ProviderUnavailableError("The Razorpay provider requires a valid razorpay_test or razorpay_live configuration.");
  }
  const keys = config.razorpay;
  return {
    id: "razorpay",
    mode: config.mode,
    online: true,
    label: null,
    async createPayment(req) {
      const rp = await createRazorpayOrder(keys, req.amountPaise, req.orderNumber);
      return {
        providerOrderId: rp.id,
        amountPaise: rp.amount,
        currency: rp.currency,
        clientPayload: { provider: "razorpay", keyId: keys.keyId, orderId: rp.id, amount: rp.amount, currency: rp.currency },
      };
    },
    verifyPayment: (p) => verifyRazorpaySignatureWith(keys.keySecret, p.providerOrderId, p.providerPaymentId, p.signature),
  };
}
