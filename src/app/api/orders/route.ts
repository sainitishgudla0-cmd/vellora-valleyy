import { NextResponse } from "next/server";
import { fail, parseBody } from "@/lib/api";
import { orderSchema } from "@/lib/validation";
import { createOrder, IdempotencyConflictError, OrderError } from "@/lib/orders";
import { hashKey, hashRequest, lookupKey, readIdempotencyKey, storeResponse, type StoredKey } from "@/lib/orders/idempotency";
import { currentPaymentProvider } from "@/lib/payments";
import { startOnlinePayment } from "@/lib/payments/checkout";
import { rateLimit } from "@/lib/rate-limit";
import { site } from "@/config/site";

/**
 * Contract: docs/API-CONTRACTS.md#post-apiorders. Provider and mode are decided by server configuration only.
 * An optional `Idempotency-Key` header makes retries safe: the same key and body replay the first response.
 */
export async function POST(req: Request) {
  if (!(await rateLimit("orders", 10, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const keyRead = readIdempotencyKey(req);
  if (keyRead.kind === "invalid") return fail("Idempotency-Key must be 16-128 characters: letters, digits, '-' or '_'.", 400);
  const parsed = await parseBody(req, orderSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;

  const provider = currentPaymentProvider();
  if (input.paymentMethod === "razorpay" && !provider?.online)
    return fail("Online payment is not available yet. Please choose pay on delivery.", 400, { paymentMethod: "Online payment is not available yet" });
  if (input.paymentMethod === "cod" && !site.allowCashOnDelivery)
    return fail("Pay on delivery is not available.", 400, { paymentMethod: "Pay on delivery is not available" });

  const claim = keyRead.kind === "key" ? { keyHash: hashKey(keyRead.key), requestHash: hashRequest(input) } : undefined;
  try {
    if (claim) {
      const earlier = await lookupKey(claim.keyHash, claim.requestHash);
      if (earlier.kind !== "none") return fromStored(earlier);
    }
    const order = await createOrder(input, { idempotency: claim });
    const summary = { number: order.number, token: order.accessToken, total: order.total };
    if (input.paymentMethod !== "razorpay") return respond(claim?.keyHash, { order: summary }, 201);

    // createOrder only succeeds for an online method when `provider` is online and its mode matches the order
    const started = await startOnlinePayment(order, order.payments[0].id, provider!);
    if (started.kind === "ready") return respond(claim?.keyHash, { order: summary, payment: started.clientPayload }, 201);
    if (started.kind === "definite")
      return respond(claim?.keyHash, { error: "We could not start the online payment. No money has been taken. Please try again or choose pay on delivery." }, 502);
    // Unknown gateway outcome: the order is kept (awaiting payment) and resolved by reconciliation.
    return respond(claim?.keyHash, ambiguousBody(order.number), 502);
  } catch (e) {
    if (e instanceof IdempotencyConflictError && claim) return fromStored(await lookupKey(claim.keyHash, claim.requestHash));
    if (e instanceof OrderError) return fail(e.message, e.status);
    console.error("[orders] unexpected failure creating order"); // no error object: it may carry customer data
    return fail("Something went wrong while placing your order. Please try again.", 500);
  }
}

/** Sends the response and, for keyed requests, stores it so a retry gets exactly the same answer. */
async function respond(keyHash: string | undefined, body: unknown, status: number) {
  if (keyHash) await storeResponse(keyHash, status, body);
  return NextResponse.json(body, { status });
}

function fromStored(s: StoredKey) {
  if (s.kind === "replay") return NextResponse.json(s.body, { status: s.status, headers: { "Idempotent-Replayed": "true" } });
  if (s.kind === "mismatch") return fail("This Idempotency-Key was already used for a different order request.", 422);
  // none (the other request failed and rolled back) or still being processed: the client may simply retry
  return NextResponse.json({ error: "Your previous request is still being processed. Please retry in a few seconds." }, { status: 409, headers: { "Retry-After": "2" } });
}

function ambiguousBody(orderNumber: string) {
  return {
    error: `We could not confirm that the online payment was started, so no money has been taken. Your order ${orderNumber} is saved as awaiting payment; please contact us or choose pay on delivery.`,
    orderNumber,
  };
}
