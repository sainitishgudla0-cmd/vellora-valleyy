import "server-only";
import crypto from "node:crypto";
import { PaymentConfigError, resolvePaymentConfig, type PaymentConfig } from "./env/payment-config";

/**
 * Razorpay integration (optional). Online payment is only offered when PAYMENT_MODE is
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

export async function createRazorpayOrder(amountPaise: number, receipt: string) {
  const cfg = razorpayConfig();
  if (!cfg) throw new Error("Online payments are not configured");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64"),
    },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Razorpay order creation failed (${res.status})`);
  return (await res.json()) as { id: string; amount: number; currency: string };
}

export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string) {
  const cfg = razorpayConfig();
  if (!cfg) return false;
  const expected = crypto.createHmac("sha256", cfg.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
