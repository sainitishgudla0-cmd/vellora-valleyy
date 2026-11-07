import "server-only";
import crypto from "node:crypto";

/**
 * Razorpay integration (optional). Online payment is only offered when BOTH
 * RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are configured. Nothing here ever
 * marks an order paid without a verified Razorpay signature.
 */
export function razorpayConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  return keyId && keySecret ? { keyId, keySecret } : null;
}

export const onlinePaymentsEnabled = () => razorpayConfig() !== null;

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
