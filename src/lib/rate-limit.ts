import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { bucketKey, consume } from "@/lib/rate-limit-store";

/**
 * Fixed-window limiter keyed by bucket + client IP, shared across server instances through Postgres
 * (`RateLimitBucket`, M9-T4). Returns true when the request may proceed. See rate-limit-store.ts.
 */
export async function rateLimit(bucket: string, limit: number, windowMs: number) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  return consume(db, bucketKey(bucket, ip), limit, windowMs);
}
