/**
 * M11 P1-T6 (F08): when the shared limiter store fails, sensitive routes refuse (429) instead of silently falling back
 * to per-instance counters, and public low-value routes keep working. The failure is injected with a temporary trigger
 * on `RateLimitBucket` that only matches the buckets used here (disposable DB; other test files are unaffected).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetMemoryStore } from "@/lib/rate-limit-store";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";

const ip = vi.hoisted(() => ({ value: "203.0.113.10" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": ip.value }) }));

import { POST as login } from "@/app/api/admin/login/route";
import { POST as otpRequest } from "@/app/api/account/otp/request/route";
import { POST as placeOrder } from "@/app/api/orders/route";
import { GET as shippingQuote } from "@/app/api/shipping/quote/route";

const BUCKETS = ["admin-login", "account-otp-request", "orders", "shipping-quote"];
const tag = Date.now().toString(36);
let seq = 0;
let owner: Awaited<ReturnType<typeof createTestAdmin>>;

async function withBrokenLimiter<T>(fn: () => Promise<T>): Promise<T> {
  const name = `vv_rl_fail_${tag}_${++seq}`;
  const list = BUCKETS.map((b) => `'${b}'`).join(",");
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected limiter outage'; END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "RateLimitBucket" FOR EACH ROW WHEN (split_part(NEW."key", ':', 1) IN (${list})) EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "RateLimitBucket"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const clearBuckets = () => db.rateLimitBucket.deleteMany({ where: { OR: BUCKETS.map((b) => ({ key: { startsWith: `${b}:` } })) } });

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ip.value = `203.0.113.${(++seq % 200) + 1}`; // a fresh client per test: real counters never interfere
  resetMemoryStore();
  owner ??= await createTestAdmin("owner");
});
afterAll(async () => {
  await clearBuckets();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("limiter store down (M11 P1-T6)", () => {
  it("admin sign-in is refused even with the right password, and works again once the store is back", async () => {
    const res = await withBrokenLimiter(() => login(post("/api/admin/login", { email: owner.email, password: owner.password })));
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await login(post("/api/admin/login", { email: owner.email, password: owner.password }))).status).toBe(200);
  });

  it("one-time-code requests are refused", async () => {
    vi.stubEnv("CUSTOMER_OTP_MODE", "mock");
    const res = await withBrokenLimiter(() => otpRequest(post("/api/account/otp/request", { email: `smoke.rl-${tag}@example.test` })));
    expect(res.status).toBe(429);
  });

  it("order placement is refused before anything is reserved", async () => {
    const before = await db.order.count();
    const res = await withBrokenLimiter(() => placeOrder(post("/api/orders", { name: "SMOKE TEST Limiter", phone: "9876543210", email: `smoke.rl-${tag}@example.test`, address: "1 Test Street", city: "Test", pincode: "560001", paymentMethod: "cod", items: [] })));
    expect(res.status).toBe(429);
    expect(await db.order.count()).toBe(before);
  });

  it("the public delivery quote keeps working on per-instance counters (fail open)", async () => {
    const res = await withBrokenLimiter(() => shippingQuote(new Request("http://localhost/api/shipping/quote?pincode=560001&subtotal=50000")));
    expect(res.status).toBe(200);
  });
});
