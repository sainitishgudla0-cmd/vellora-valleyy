import { NextResponse } from "next/server";
import { log, errorName } from "@/lib/log";
import { fail, parseBody } from "@/lib/api";
import { IdempotencyConflictError } from "@/lib/orders";
import { hashKey, hashRequest, lookupKey, readIdempotencyKey, storeResponse, type StoredKey } from "@/lib/orders/idempotency";
import { orderFailure } from "@/lib/wholesale/http";
import { placeWholesaleOrder } from "@/lib/wholesale/orders";
import { requireBusiness } from "@/lib/wholesale/auth";
import { businessOrderSchema } from "@/lib/wholesale/schemas";
import { rateLimit } from "@/lib/rate-limit";

/**
 * A direct wholesale order at the buyer's price-list prices (MOQ and case packs enforced, credit limit for credit terms).
 * Payment is offline (staff confirm it). Supports `Idempotency-Key` like the retail route.
 */
export async function POST(req: Request) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("business-orders", 20, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const keyRead = readIdempotencyKey(req);
  if (keyRead.kind === "invalid") return fail("Idempotency-Key must be 16-128 characters: letters, digits, '-' or '_'.", 400);
  const parsed = await parseBody(req, businessOrderSchema);
  if ("response" in parsed) return parsed.response;
  const claim = keyRead.kind === "key" ? { keyHash: hashKey(`business:${auth.account.id}:${keyRead.key}`), requestHash: hashRequest(parsed.data) } : undefined;
  try {
    if (claim) {
      const earlier = await lookupKey(claim.keyHash, claim.requestHash);
      if (earlier.kind !== "none") return fromStored(earlier);
    }
    const order = await placeWholesaleOrder(auth.account, auth.customer.customerId, parsed.data, claim);
    const body = { order: { number: order.number, token: order.accessToken, total: order.total } };
    if (claim) await storeResponse(claim.keyHash, 201, body);
    return NextResponse.json(body, { status: 201 });
  } catch (e) {
    if (e instanceof IdempotencyConflictError && claim) return fromStored(await lookupKey(claim.keyHash, claim.requestHash));
    const o = orderFailure(e);
    if (o) return o;
    log.error("business.order_create_failed", { errorName: errorName(e) });
    return fail("Something went wrong while placing your order. Please try again.", 500);
  }
}

function fromStored(s: StoredKey) {
  if (s.kind === "replay") return NextResponse.json(s.body, { status: s.status, headers: { "Idempotent-Replayed": "true" } });
  if (s.kind === "mismatch") return fail("This Idempotency-Key was already used for a different order request.", 422);
  return NextResponse.json({ error: "Your previous request is still being processed. Please retry in a few seconds." }, { status: 409, headers: { "Retry-After": "2" } });
}
