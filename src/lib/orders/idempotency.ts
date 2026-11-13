import "server-only";
import { log } from "@/lib/log";
import crypto from "node:crypto";
import { db } from "@/lib/db";

/**
 * `Idempotency-Key` support for POST /api/orders (M3-T4, ADR 0011).
 * The client key is never stored, only its SHA-256. A key is claimed inside the order-creating transaction, so
 * "key exists" always means "an order was created for it". The final response is stored for 24 hours and replayed
 * verbatim; the same key with a different body is refused.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type KeyRead = { kind: "none" } | { kind: "invalid" } | { kind: "key"; key: string };

export function readIdempotencyKey(req: Request): KeyRead {
  const raw = req.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return { kind: "none" };
  const key = raw.trim();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? { kind: "key", key } : { kind: "invalid" };
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const hashKey = (key: string) => sha256(`orders:${key}`);

/** Stable JSON (sorted object keys) so equal requests hash equally regardless of property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const hashRequest = (body: unknown) => sha256(canonicalJson(body));

export type StoredKey =
  | { kind: "none" }
  | { kind: "mismatch" }
  | { kind: "in_progress" }
  | { kind: "replay"; status: number; body: unknown };

/** What an earlier request with this key left behind (expired keys count as none). */
export async function lookupKey(keyHash: string, requestHash: string, now = new Date()): Promise<StoredKey> {
  const row = await db.idempotencyKey.findUnique({ where: { keyHash } });
  if (!row || row.expiresAt < now) return { kind: "none" };
  if (row.requestHash !== requestHash) return { kind: "mismatch" };
  if (row.responseStatus === null || row.responseBody === null) return { kind: "in_progress" };
  return { kind: "replay", status: row.responseStatus, body: JSON.parse(row.responseBody) };
}

/** Stores the final response. Best effort: the order exists either way, a lost write only means a later replay says "in progress". */
export async function storeResponse(keyHash: string, status: number, body: unknown): Promise<void> {
  try {
    await db.idempotencyKey.updateMany({ where: { keyHash, responseStatus: null }, data: { responseStatus: status, responseBody: JSON.stringify(body) } });
  } catch {
    log.error("orders.idempotent_response_not_stored");
  }
}

/** Housekeeping for the expiry job: removes keys past their 24 h life. */
export async function deleteExpiredKeys(now = new Date()): Promise<number> {
  return (await db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
