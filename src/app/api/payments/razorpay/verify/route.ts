import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { verifyRazorpaySignature } from "@/lib/payments";

const schema = z.object({
  orderNumber: z.string().max(40),
  token: z.string().max(60),
  razorpay_order_id: z.string().max(60),
  razorpay_payment_id: z.string().max(60),
  razorpay_signature: z.string().max(200),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const b = parsed.data;
  const order = await db.order.findUnique({ where: { number: b.orderNumber } });
  if (!order || order.accessToken !== b.token || order.razorpayOrderId !== b.razorpay_order_id) return fail("Order not found", 404);
  if (!verifyRazorpaySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
    await db.order.update({ where: { id: order.id }, data: { paymentStatus: "failed" } });
    return fail("Payment verification failed. If money was deducted, please contact us with your order number.", 400);
  }
  await db.order.update({
    where: { id: order.id },
    data: { status: "paid", paymentStatus: "paid", razorpayPaymentId: b.razorpay_payment_id },
  });
  return json({ ok: true });
}
