import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { orderSchema } from "@/lib/validation";
import { createOrder, OrderError } from "@/lib/orders";
import { createRazorpayOrder, onlinePaymentsEnabled, razorpayConfig } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { site } from "@/config/site";

export async function POST(req: Request) {
  if (!(await rateLimit("orders", 10, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const parsed = await parseBody(req, orderSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;

  if (input.paymentMethod === "razorpay" && !onlinePaymentsEnabled())
    return fail("Online payment is not available yet. Please choose pay on delivery.", 400, { paymentMethod: "Online payment is not available yet" });
  if (input.paymentMethod === "cod" && !site.allowCashOnDelivery)
    return fail("Pay on delivery is not available.", 400, { paymentMethod: "Pay on delivery is not available" });

  try {
    const order = await createOrder(input);
    if (input.paymentMethod === "razorpay") {
      try {
        const rp = await createRazorpayOrder(order.total, order.number);
        await db.order.update({ where: { id: order.id }, data: { razorpayOrderId: rp.id } });
        return json(
          {
            order: { number: order.number, token: order.accessToken, total: order.total },
            payment: { provider: "razorpay", keyId: razorpayConfig()!.keyId, orderId: rp.id, amount: rp.amount, currency: rp.currency },
          },
          201,
        );
      } catch (e) {
        await db.order.update({ where: { id: order.id }, data: { status: "cancelled", paymentStatus: "failed" } });
        console.error(e);
        return fail("We could not start the online payment. No money has been taken. Please try again or choose pay on delivery.", 502);
      }
    }
    return json({ order: { number: order.number, token: order.accessToken, total: order.total } }, 201);
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status);
    console.error(e);
    return fail("Something went wrong while placing your order. Please try again.", 500);
  }
}
