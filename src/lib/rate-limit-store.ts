import "server-only";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { log, errorName } from "@/lib/log";

/**
 * Fixed-window counters (M9-T4, ADR 0017).
 *
 * `database` (default): one atomic INSERT … ON CONFLICT DO UPDATE per request on `RateLimitBucket`, so every
 * server instance shares the same counters and N parallel requests can never let more than `limit` through.
 * `memory`: per-instance Map (RATE_LIMIT_STORE=memory); used as the automatic fallback if the database is
 * unreachable, so a database hiccup degrades to the old per-instance behaviour instead of blocking customers
 * (or removing the limit altogether).
 *
 * Timestamps are written as UTC wall-clock via `::timestamptz AT TIME ZONE 'UTC'`, so the result does not depend
 * on the database session time zone (the M7 outbox bug).
 */
type Db = Pick<PrismaClient, "$queryRaw" | "rateLimitBucket">;

export type Decision = { allowed: boolean; count: number };

export async function consumeShared(client: Db, key: string, limit: number, windowMs: number, now = new Date()): Promise<Decision> {
  const nowIso = now.toISOString();
  const resetIso = new Date(now.getTime() + windowMs).toISOString();
  const rows = await client.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${key}, 1, (${resetIso}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("key") DO UPDATE SET
      "count"   = CASE WHEN "RateLimitBucket"."resetAt" <= (${nowIso}::timestamptz AT TIME ZONE 'UTC') THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= (${nowIso}::timestamptz AT TIME ZONE 'UTC') THEN (${resetIso}::timestamptz AT TIME ZONE 'UTC') ELSE "RateLimitBucket"."resetAt" END
    RETURNING "count"`;
  const count = Number(rows[0]?.count);
  if (!Number.isFinite(count)) throw new Error("rate limit store returned no count");
  return { allowed: count <= limit, count };
}

/** Deletes windows that ended more than an hour ago. Cheap (indexed); called on ~1% of requests and by the cron job. */
export async function purgeExpired(client: Pick<PrismaClient, "rateLimitBucket">, now = new Date()): Promise<number> {
  const r = await client.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date(now.getTime() - 60 * 60_000) } } });
  return r.count;
}

const memory = new Map<string, { count: number; reset: number }>();

export function consumeMemory(key: string, limit: number, windowMs: number, now = Date.now()): Decision {
  const entry = memory.get(key);
  if (!entry || entry.reset <= now) {
    if (memory.size > 5000) for (const [k, v] of memory) if (v.reset <= now) memory.delete(k); // bounded
    memory.set(key, { count: 1, reset: now + windowMs });
    return { allowed: 1 <= limit, count: 1 };
  }
  entry.count++;
  return { allowed: entry.count <= limit, count: entry.count };
}

export const resetMemoryStore = () => memory.clear();

/** "<bucket>:<hmac of the IP>": raw IP addresses (personal data) never reach the database. */
export function bucketKey(bucket: string, ip: string, secret = process.env.SESSION_SECRET): string {
  const digest = crypto.createHmac("sha256", secret || "velora-rate-limit").update(ip).digest("hex").slice(0, 32);
  return `${bucket}:${digest}`;
}

let lastFallbackLog = 0;

export async function consume(client: Db, key: string, limit: number, windowMs: number): Promise<boolean> {
  if (process.env.RATE_LIMIT_STORE?.trim() === "memory") return consumeMemory(key, limit, windowMs).allowed;
  try {
    const d = await consumeShared(client, key, limit, windowMs);
    if (Math.random() < 0.01) void purgeExpired(client).catch(() => {});
    return d.allowed;
  } catch (e) {
    const t = Date.now();
    if (t - lastFallbackLog > 60_000) {
      lastFallbackLog = t;
      log.warn("rate_limit.database_unavailable", { errorName: errorName(e), effect: "per-instance fallback" });
    }
    return consumeMemory(key, limit, windowMs).allowed;
  }
}
