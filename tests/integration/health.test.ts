import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { db } from "@/lib/db";
import { setLogSink, type LogRecord } from "@/lib/log";

afterEach(() => setLogSink(null));

describe("GET /api/health (M9-T5)", () => {
  it("is 200 { ok: true } and never cached while the database answers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is 503 { ok: false } with no error detail when the database is unreachable, and logs the class only", async () => {
    const records: LogRecord[] = [];
    setLogSink((r) => records.push(r));
    vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:5432 user=secret_user"));
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toMatch(/ECONNREFUSED|secret|10\.1/);
    expect(records[0]).toMatchObject({ event: "health.database_unreachable", errorName: "Error" });
    expect(JSON.stringify(records[0])).not.toMatch(/ECONNREFUSED|secret_user|10\.1/);
  });

  it("is 503 when the database hangs (times out instead of hanging the probe)", async () => {
    vi.useFakeTimers();
    vi.spyOn(db, "$queryRaw").mockReturnValue(new Promise(() => {}) as never);
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3100);
    expect((await pending).status).toBe(503);
    vi.useRealTimers();
  });
});
