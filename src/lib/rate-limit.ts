import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { bucketKey, consume, type FailMode } from "@/lib/rate-limit-store";
import { clientIp } from "@/lib/client-ip";

/**
 * Fixed-window limiter keyed by bucket + client IP, shared across server instances through Postgres
 * (`RateLimitBucket`, M9-T4). Returns true when the request may proceed. See rate-limit-store.ts.
 *
 * M11 P1-T6 (F08): what happens when the shared store is unreachable is decided per bucket here, in one place.
 * `closed` refuses the request (the route answers 429); `open` falls back to a per-instance counter. A bucket that is
 * not listed is treated as `closed`, so a new sensitive route can never fail open by omission
 * (`tests/unit/rate-limit-policy.test.ts` also requires every bucket used under src/app to be listed).
 */
export const RATE_LIMIT_POLICY: Readonly<Record<string, FailMode>> = {
  // credentials and one-time codes
  "admin-login": "closed",
  "admin-password": "closed",
  "account-otp-request": "closed",
  "account-otp-verify": "closed",
  "account-claim": "closed",
  "account-export": "closed",
  // money and stock
  "payment-verify": "closed",
  "mock-confirm": "closed",
  orders: "closed",
  "business-orders": "closed",
  "business-quote": "closed",
  "business-quote-accept": "closed",
  "business-apply": "closed",
  // public, low-value: a database hiccup must not take these down
  "shipping-quote": "open",
  "order-invoice": "open",
  newsletter: "open",
  enquiries: "open",
};

export const failModeFor = (bucket: string): FailMode => RATE_LIMIT_POLICY[bucket] ?? "closed";

export async function rateLimit(bucket: string, limit: number, windowMs: number) {
  const h = await headers();
  const ip = clientIp(h); // trusted-proxy aware (M12 VA-08): a client cannot choose its own key
  return consume(db, bucketKey(bucket, ip), limit, windowMs, failModeFor(bucket));
}
