import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { setLogSink, type LogRecord } from "@/lib/log";
import { bucketKey, consume, consumeMemory, consumeShared, purgeExpired, resetMemoryStore } from "@/lib/rate-limit-store";

const P = "smoke.rl."; // test-data marker: removed in beforeEach
const clean = () => db.rateLimitBucket.deleteMany({ where: { key: { startsWith: P } } });
beforeEach(async () => {
  await clean();
  resetMemoryStore();
});
afterAll(clean);

describe("shared rate limiter (M9-T4)", () => {
  it("allows exactly `limit` requests per window, then blocks, then allows again after the window", async () => {
    const t0 = new Date("2026-11-12T10:00:00Z");
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await consumeShared(db, `${P}a`, 3, 60_000, new Date(t0.getTime() + i * 1000))).allowed);
    expect(results).toEqual([true, true, true, false, false]);
    expect((await consumeShared(db, `${P}a`, 3, 60_000, new Date(t0.getTime() + 60_000))).allowed).toBe(true); // window ended exactly now
    const row = await db.rateLimitBucket.findUnique({ where: { key: `${P}a` } });
    expect(row?.count).toBe(1);
    expect(row?.resetAt.toISOString()).toBe("2026-11-12T10:02:00.000Z"); // stored as UTC whatever the session time zone is
  });

  it("keeps buckets and clients independent", async () => {
    expect((await consumeShared(db, `${P}x`, 1, 60_000)).allowed).toBe(true);
    expect((await consumeShared(db, `${P}x`, 1, 60_000)).allowed).toBe(false);
    expect((await consumeShared(db, `${P}y`, 1, 60_000)).allowed).toBe(true);
  });

  it("60 parallel requests across 3 separate clients (server instances) let exactly `limit` through", async () => {
    const clients = [db, new PrismaClient(), new PrismaClient()];
    try {
      const out = await Promise.all(Array.from({ length: 60 }, (_, i) => consumeShared(clients[i % 3], `${P}race`, 10, 60_000)));
      expect(out.filter((d) => d.allowed)).toHaveLength(10);
      expect((await db.rateLimitBucket.findUnique({ where: { key: `${P}race` } }))?.count).toBe(60);
    } finally {
      await Promise.all(clients.slice(1).map((c) => c.$disconnect()));
    }
  });

  it("a concurrent burst at the window boundary never over-admits", async () => {
    const t = new Date("2026-11-12T11:00:00Z");
    await consumeShared(db, `${P}edge`, 5, 1000, t);
    const later = new Date(t.getTime() + 1000);
    const out = await Promise.all(Array.from({ length: 20 }, () => consumeShared(db, `${P}edge`, 5, 1000, later)));
    expect(out.filter((d) => d.allowed)).toHaveLength(5);
  });

  it("consume() uses the database by default and the shared count is visible to a second caller", async () => {
    expect(await consume(db, `${P}c`, 2, 60_000)).toBe(true);
    expect(await consume(db, `${P}c`, 2, 60_000)).toBe(true);
    expect(await consume(db, `${P}c`, 2, 60_000)).toBe(false);
    expect((await db.rateLimitBucket.findUnique({ where: { key: `${P}c` } }))?.count).toBe(3);
  });

  it("falls back to a per-instance limit (and warns once) when the database is unavailable", async () => {
    const records: LogRecord[] = [];
    setLogSink((r) => records.push(r));
    const broken = { $queryRaw: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")), rateLimitBucket: db.rateLimitBucket } as never;
    const r = [await consume(broken, `${P}f`, 2, 60_000), await consume(broken, `${P}f`, 2, 60_000), await consume(broken, `${P}f`, 2, 60_000)];
    setLogSink(null);
    expect(r).toEqual([true, true, false]); // still limited, never fail-open
    expect(records.filter((x) => x.event === "rate_limit.database_unavailable").length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(records)).not.toContain("ECONNREFUSED");
  });

  it("RATE_LIMIT_STORE=memory never touches the database", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "memory");
    const spy = vi.spyOn(db, "$queryRaw");
    expect(await consume(db, `${P}m`, 1, 60_000)).toBe(true);
    expect(await consume(db, `${P}m`, 1, 60_000)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("memory counter resets after its window", () => {
    expect(consumeMemory(`${P}w`, 1, 1000, 0).allowed).toBe(true);
    expect(consumeMemory(`${P}w`, 1, 1000, 500).allowed).toBe(false);
    expect(consumeMemory(`${P}w`, 1, 1000, 1000).allowed).toBe(true);
  });

  it("purges only windows that ended over an hour ago", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    await db.rateLimitBucket.createMany({ data: [
      { key: `${P}old`, count: 1, resetAt: new Date("2026-11-12T10:30:00Z") },
      { key: `${P}recent`, count: 1, resetAt: new Date("2026-11-12T11:30:00Z") },
      { key: `${P}live`, count: 1, resetAt: new Date("2026-11-12T12:30:00Z") },
    ] });
    expect(await purgeExpired(db, now)).toBeGreaterThanOrEqual(1);
    const left = (await db.rateLimitBucket.findMany({ where: { key: { startsWith: P } } })).map((r) => r.key).sort();
    expect(left).toEqual([`${P}live`, `${P}recent`]);
  });

  it("keys never contain the raw IP address", () => {
    const k = bucketKey("orders", "203.0.113.7", "test-secret");
    expect(k).toMatch(/^orders:[0-9a-f]{32}$/);
    expect(k).not.toContain("203");
    expect(bucketKey("orders", "203.0.113.7", "test-secret")).toBe(k);
    expect(bucketKey("orders", "203.0.113.8", "test-secret")).not.toBe(k);
    expect(bucketKey("orders", "203.0.113.7", "other-secret")).not.toBe(k);
  });
});
