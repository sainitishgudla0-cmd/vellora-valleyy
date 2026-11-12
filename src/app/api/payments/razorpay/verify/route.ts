import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { razorpayConfig, verifyRazorpaySignature } from "@/lib/payments";
import { decideVerification, matchesOrder, PAYABLE_PAYMENT_STATUSES, type VerifiableOrder } from "@/lib/payment-verification";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  orderNumber: z.string().max(40),
  token: z.string().max(60),
  razorpay_order_id: z.string().max(60),
  razorpay_payment_id: z.string().max(60),
  razorpay_signature: z.string().max(200),
});

const ORDER_FIELDS = {
  id: true,
  number: true,
  accessToken: true,
  paymentMethod: true,
  status: true,
  paymentStatus: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
} as const;

const CONFLICT_MESSAGE =
  "We received your payment confirmation but could not apply it to this order automatically. Please contact us with your order number and we will resolve it.";

const findOrder = (number: string): Promise<VerifiableOrder | null> => db.order.findUnique({ where: { number }, select: ORDER_FIELDS });

/** Contract: docs/API-CONTRACTS.md#payment-verify */
export async function POST(req: Request) {
  if (!(await rateLimit("payment-verify", 20, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const b = parsed.data;

  const order = await findOrder(b.orderNumber);
  if (!matchesOrder(order, b)) return fail("Order not found", 404);
  if (!razorpayConfig()) return fail("Payment verification is temporarily unavailable. No changes were made; please contact us with your order number.", 503);

  const decision = decideVerification(order, b, verifyRazorpaySignature);
  switch (decision.kind) {
    case "not_found":
      return fail("Order not found", 404);
    case "invalid_signature":
      // never mutate payment state on an unverifiable request
      return fail("Payment verification failed. If money was deducted, please contact us with your order number.", 400);
    case "already_paid":
      return json({ ok: true, alreadyVerified: true });
    case "conflict":
      console.error(`[payments] verify conflict order=${order.number} reason=${decision.reason} status=${order.status}/${order.paymentStatus}`);
      return fail(CONFLICT_MESSAGE, 409);
    case "mark_paid": {
      // conditional update: only succeeds if the order is still payable (guards concurrent requests and admin changes)
      const updated = await db.order.updateMany({
        where: { id: order.id, status: "awaiting_payment", paymentStatus: { in: [...PAYABLE_PAYMENT_STATUSES] } },
        data: { status: "paid", paymentStatus: "paid", razorpayPaymentId: b.razorpay_payment_id },
      });
      if (updated.count === 1) return json({ ok: true });
      const current = await findOrder(b.orderNumber);
      if (current?.paymentStatus === "paid" && current.razorpayPaymentId === b.razorpay_payment_id) return json({ ok: true, alreadyVerified: true });
      console.error(`[payments] verify lost race order=${order.number} status=${current?.status}/${current?.paymentStatus}`);
      return fail(CONFLICT_MESSAGE, 409);
    }
  }
}
