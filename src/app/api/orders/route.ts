import { fail, json, parseBody } from "@/lib/api";
import { orderSchema } from "@/lib/validation";
import { createOrder, OrderError } from "@/lib/orders";
import { currentPaymentProvider } from "@/lib/payments";
import { startOnlinePayment } from "@/lib/payments/checkout";
import { rateLimit } from "@/lib/rate-limit";
import { site } from "@/config/site";

/** Contract: docs/API-CONTRACTS.md#post-apiorders. Provider and mode are decided by server configuration only. */
export async function POST(req: Request) {
  if (!(await rateLimit("orders", 10, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const parsed = await parseBody(req, orderSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;

  const provider = currentPaymentProvider();
  if (input.paymentMethod === "razorpay" && !provider?.online)
    return fail("Online payment is not available yet. Please choose pay on delivery.", 400, { paymentMethod: "Online payment is not available yet" });
  if (input.paymentMethod === "cod" && !site.allowCashOnDelivery)
    return fail("Pay on delivery is not available.", 400, { paymentMethod: "Pay on delivery is not available" });

  try {
    const order = await createOrder(input);
    const summary = { number: order.number, token: order.accessToken, total: order.total };
    if (input.paymentMethod !== "razorpay") return json({ order: summary }, 201);

    // createOrder only succeeds for an online method when `provider` is online and its mode matches the order
    const started = await startOnlinePayment(order, order.payments[0].id, provider!);
    if (started.kind === "ready") return json({ order: summary, payment: started.clientPayload }, 201);
    if (started.kind === "definite") return fail("We could not start the online payment. No money has been taken. Please try again or choose pay on delivery.", 502);
    // Unknown gateway outcome: the order is kept (awaiting payment) and resolved by reconciliation.
    return ambiguousResponse(order.number);
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status);
    console.error("[orders] unexpected failure creating order"); // no error object: it may carry customer data
    return fail("Something went wrong while placing your order. Please try again.", 500);
  }
}

function ambiguousResponse(orderNumber: string) {
  return Response.json(
    {
      error: `We could not confirm that the online payment was started, so no money has been taken. Your order ${orderNumber} is saved as awaiting payment; please contact us or choose pay on delivery.`,
      orderNumber,
    },
    { status: 502 },
  );
}
