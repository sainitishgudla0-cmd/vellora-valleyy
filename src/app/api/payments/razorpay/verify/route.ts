import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { safePaymentConfig } from "@/lib/payments";
import { verifyRazorpayCheckout } from "@/lib/payments/razorpay-verify";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  orderNumber: z.string().max(40),
  token: z.string().max(60),
  razorpay_order_id: z.string().max(60),
  razorpay_payment_id: z.string().max(60),
  razorpay_signature: z.string().max(200),
});

const CONFLICT_MESSAGE =
  "We received your payment confirmation but could not apply it to this order automatically. Please contact us with your order number and we will resolve it.";

/** Contract: docs/API-CONTRACTS.md#payment-verify */
export async function POST(req: Request) {
  if (!(await rateLimit("payment-verify", 20, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;

  const result = await verifyRazorpayCheckout(parsed.data, safePaymentConfig());
  switch (result.kind) {
    case "paid":
      return json({ ok: true });
    case "already_paid":
      return json({ ok: true, alreadyVerified: true });
    case "not_found":
      return fail("Order not found", 404);
    case "unavailable":
      return fail("Payment verification is temporarily unavailable. No changes were made; please contact us with your order number.", 503);
    case "invalid_signature":
      // never mutate payment state on an unverifiable request
      return fail("Payment verification failed. If money was deducted, please contact us with your order number.", 400);
    case "pending":
      // authorized but not captured: nothing is marked paid; reconciliation completes it if the payment settles
      return json({ ok: false, pending: true, message: "Your payment is being confirmed by the payment provider. Your order is saved and will be updated once it settles." }, 202);
    case "gateway_unavailable":
      return fail("We could not confirm your payment with the payment provider just now. No changes were made, and it will be checked again. If money was deducted, please contact us with your order number.", 503);
    case "payment_failed":
      return fail("The payment was not completed. No money has been taken for this order.", 400);
    case "conflict":
      return fail(CONFLICT_MESSAGE, 409);
  }
}
