/** M5-T2: emailed sign-in codes: brute-force limits, enumeration safety, sessions, through the real routes and Postgres. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { MAX_ATTEMPTS, MAX_PER_HOUR, OTP_TTL_MS, RESEND_COOLDOWN_S, issueOtp, verifyOtp } from "@/lib/auth/otp";
import { mockOtpOutbox } from "@/lib/auth/otp-sender";
import { CUSTOMER_COOKIE, CUSTOMER_SESSION_IDLE_MS } from "@/lib/auth/customer";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail, lastCode, signInCustomer } from "../support/customer";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as otpRequest } from "@/app/api/account/otp/request/route";
import { POST as otpVerify } from "@/app/api/account/otp/verify/route";
import { POST as logout } from "@/app/api/account/logout/route";
import { GET as me } from "@/app/api/account/me/route";

const mk = (url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers: { host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any>, setCookie: res.headers.get("set-cookie"), retryAfter: res.headers.get("retry-after") });
const request = (email: string, headers?: Record<string, string>) => otpRequest(mk("/api/account/otp/request", { email }, undefined, headers));
const verify = (body: Record<string, unknown>, cookie?: string) => otpVerify(mk("/api/account/otp/verify", body, cookie));
const wrongCode = (real: string) => (real === "000000" ? "111111" : "000000");
/** Lets the resend cooldown pass without sleeping. */
const age = (email: string, seconds = 31) => db.otpChallenge.updateMany({ data: { createdAt: new Date(Date.now() - seconds * 1000) }, where: {} });

beforeEach(async () => {
  customerTestEnv();
  rate.rateLimit.mockResolvedValue(true);
  await db.otpChallenge.deleteMany({});
  mockOtpOutbox.length = 0;
});
afterAll(async () => {
  await cleanupCustomerFixtures();
  await db.$disconnect();
});

describe("requesting a code", () => {
  it("sends a 6-digit code through the mock sender and answers 202 without revealing anything", async () => {
    const email = freshEmail();
    const r = await read(await request(email));
    expect(r.status).toBe(202);
    expect(Object.keys(r.body).sort()).toEqual(["message", "ok"]);
    expect(lastCode(email)).toMatch(/^\d{6}$/);
    expect(JSON.stringify(r.body)).not.toContain(lastCode(email));
  });

  it("answers identically for an address with an account and one without (no enumeration)", async () => {
    const known = await signInCustomer();
    await age(known.email);
    const unknown = freshEmail();
    const a = await read(await request(known.email));
    const b = await read(await request(unknown));
    expect(a).toEqual(b);
  });

  it("stores neither the address nor the code in the clear", async () => {
    const email = freshEmail();
    await request(email);
    const code = lastCode(email);
    const rows = JSON.stringify(await db.otpChallenge.findMany());
    expect(rows).not.toContain(email);
    expect(rows).not.toContain(email.split("@")[0]);
    expect(rows).not.toContain(`"${code}"`);
    expect(JSON.stringify(await db.otpChallenge.findFirstOrThrow())).toMatch(/"codeHash":"[0-9a-f]{64}"/);
  });

  it("is unavailable (503) and sends nothing when no real sender is configured, and in production/preview even with mock set", async () => {
    vi.stubEnv("CUSTOMER_OTP_MODE", "");
    expect((await request(freshEmail())).status).toBe(503);
    vi.stubEnv("CUSTOMER_OTP_MODE", "mock");
    vi.stubEnv("APP_ENV", "production");
    expect((await request(freshEmail())).status).toBe(503);
    vi.stubEnv("APP_ENV", "preview");
    expect((await request(freshEmail())).status).toBe(503);
    expect(mockOtpOutbox).toHaveLength(0);
    expect(await db.otpChallenge.count()).toBe(0);
  });

  it("validates input, honours the IP rate limit, refuses cross-origin requests and a missing SESSION_SECRET", async () => {
    expect((await otpRequest(mk("/api/account/otp/request", { email: "nope" }))).status).toBe(422);
    expect((await otpRequest(mk("/api/account/otp/request", { email: "a@example.com", extra: 1 }))).status).toBe(422);
    expect((await otpRequest(new Request("http://localhost/api/account/otp/request", { method: "POST", body: "x" }))).status).toBe(400);
    rate.rateLimit.mockResolvedValue(false);
    expect((await request(freshEmail())).status).toBe(429);
    rate.rateLimit.mockResolvedValue(true);
    expect((await request(freshEmail(), { origin: "https://evil.example" })).status).toBe(403);
    vi.stubEnv("SESSION_SECRET", "short");
    expect((await request(freshEmail())).status).toBe(503);
  });

  it("enforces a resend cooldown and an hourly cap per address", async () => {
    const email = freshEmail();
    expect((await request(email)).status).toBe(202);
    const again = await read(await request(email));
    expect(again.status).toBe(429);
    expect(Number(again.retryAfter)).toBeGreaterThan(0);
    expect(Number(again.retryAfter)).toBeLessThanOrEqual(RESEND_COOLDOWN_S);
    for (let i = 1; i < MAX_PER_HOUR; i++) {
      await age(email);
      expect((await request(email)).status, `request ${i + 1}`).toBe(202);
    }
    await age(email);
    expect((await request(email)).status).toBe(429); // cap reached even after the cooldown
    expect(await db.otpChallenge.count()).toBe(MAX_PER_HOUR);
    expect(mockOtpOutbox).toHaveLength(MAX_PER_HOUR); // the refused ones sent nothing
  });

  it("a new code retires the previous one: only the newest ever works", async () => {
    const email = freshEmail();
    await request(email);
    const first = lastCode(email);
    await age(email);
    await request(email);
    const second = lastCode(email);
    expect(second).not.toBe(first); // (a 1-in-a-million collision would only make this assertion skip the point)
    expect((await verify({ email, code: first, acceptTerms: true })).status).toBe(401);
    expect((await verify({ email, code: second, acceptTerms: true })).status).toBe(200);
  });
});

describe("verifying a code", () => {
  it("signs in with the right code: HttpOnly SameSite=Lax cookie, account created with consent recorded", async () => {
    const email = freshEmail();
    await request(email);
    const r = await read(await verify({ email: email.toUpperCase(), code: lastCode(email), acceptTerms: true, marketing: true }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, created: true } });
    expect(r.setCookie).toMatch(new RegExp(`^${CUSTOMER_COOKIE}=[\\w-]{40,};`));
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=lax/i);
    expect(r.setCookie).toMatch(/Max-Age=2592000/);
    const c = await db.customer.findUniqueOrThrow({ where: { email }, include: { consents: true } });
    expect(c.marketingConsent).toBe(true);
    expect(c.consents.map((x) => `${x.purpose}:${x.granted}:${x.version}`).sort()).toEqual(["marketing:true:2026-11", "terms_privacy:true:2026-11"]);
    const cookie = r.setCookie!.split(";")[0];
    expect((await read(await me(mk("/api/account/me", undefined, cookie)))).body.customer.email).toBe(email);
  });

  it("a code works once: replaying it, or using it after it succeeded, fails", async () => {
    const email = freshEmail();
    await request(email);
    const code = lastCode(email);
    expect((await verify({ email, code, acceptTerms: true })).status).toBe(200);
    expect((await verify({ email, code, acceptTerms: true })).status).toBe(401);
    expect(await db.customer.count({ where: { email } })).toBe(1);
  });

  it("a returning customer needs no consent again and is not 'created' twice", async () => {
    const first = await signInCustomer();
    mockOtpOutbox.length = 0;
    await age(first.email);
    await request(first.email);
    const r = await read(await verify({ email: first.email, code: lastCode(first.email) }));
    expect(r).toMatchObject({ status: 200, body: { created: false } });
    expect(await db.consentRecord.count({ where: { customerId: first.customerId } })).toBe(1);
  });

  it("first sign-in without accepting the terms is refused (409 terms_required) but the code stays usable", async () => {
    const email = freshEmail();
    await request(email);
    const code = lastCode(email);
    const r = await read(await verify({ email, code }));
    expect(r).toMatchObject({ status: 409, body: { code: "terms_required" }, setCookie: null });
    expect(await db.customer.count({ where: { email } })).toBe(0);
    expect((await verify({ email, code, acceptTerms: true })).status).toBe(200);
  });

  it("a wrong code is a generic 401, wrong-code checks do not reveal terms/account state", async () => {
    const email = freshEmail();
    await request(email);
    const r = await read(await verify({ email, code: wrongCode(lastCode(email)), acceptTerms: true }));
    expect(r).toEqual({ status: 401, body: { error: "That code is incorrect or has expired." }, setCookie: null, retryAfter: null });
    const none = await read(await verify({ email: freshEmail(), code: "123456" })); // never requested
    expect(none.status).toBe(401);
    expect(none.body).toEqual(r.body);
  });

  it("brute force: after MAX_ATTEMPTS wrong guesses even the correct code is refused", async () => {
    const email = freshEmail();
    await request(email);
    const real = lastCode(email);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await verify({ email, code: wrongCode(real), acceptTerms: true })).status).toBe(401);
    expect((await db.otpChallenge.findFirstOrThrow()).attempts).toBe(MAX_ATTEMPTS);
    expect((await verify({ email, code: real, acceptTerms: true })).status).toBe(401);
    expect(await db.customer.count({ where: { email } })).toBe(0);
  });

  it("brute force: parallel guesses cannot exceed the attempt cap", async () => {
    const email = freshEmail();
    await request(email);
    const real = lastCode(email);
    const results = await Promise.all(Array.from({ length: 20 }, () => verify({ email, code: wrongCode(real), acceptTerms: true })));
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect((await db.otpChallenge.findFirstOrThrow()).attempts).toBe(MAX_ATTEMPTS); // never counted past the cap
    expect((await verify({ email, code: real, acceptTerms: true })).status).toBe(401);
  });

  it("brute force: the total number of guesses per address per hour is bounded by attempts x codes", async () => {
    const email = freshEmail();
    let guesses = 0;
    for (let round = 0; round < MAX_PER_HOUR + 2; round++) {
      await age(email);
      const issued = await request(email);
      if (issued.status !== 202) break;
      const real = lastCode(email);
      for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
        const r = await verify({ email, code: wrongCode(real), acceptTerms: true });
        if (r.status === 401 && (await db.otpChallenge.findFirst({ where: { consumedAt: null }, orderBy: { createdAt: "desc" } }))!.attempts <= MAX_ATTEMPTS) guesses++;
      }
    }
    expect(await db.otpChallenge.count()).toBe(MAX_PER_HOUR);
    const counted = (await db.otpChallenge.findMany()).reduce((s, c) => s + c.attempts, 0);
    expect(counted).toBeLessThanOrEqual(MAX_PER_HOUR * MAX_ATTEMPTS);
    expect(guesses).toBeGreaterThan(0);
  });

  it("expired codes are refused", async () => {
    const email = freshEmail();
    await request(email);
    const code = lastCode(email);
    await db.otpChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify({ email, code, acceptTerms: true })).status).toBe(401);
    expect(OTP_TTL_MS).toBe(10 * 60_000);
  });

  it("two parallel verifications of the same right code produce exactly one session", async () => {
    const email = freshEmail();
    await request(email);
    const code = lastCode(email);
    const results = await Promise.all(Array.from({ length: 6 }, () => verify({ email, code, acceptTerms: true })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.customer.count({ where: { email } })).toBe(1);
    expect(await db.customerSession.count({ where: { customer: { email } } })).toBe(1);
  });

  it("validates the body and honours the verify rate limit and origin check", async () => {
    expect((await verify({ email: "a@example.com", code: "12" })).status).toBe(422);
    expect((await verify({ email: "a@example.com", code: "123456", customerId: "x" })).status).toBe(422);
    rate.rateLimit.mockResolvedValue(false);
    expect((await verify({ email: "a@example.com", code: "123456" })).status).toBe(429);
    rate.rateLimit.mockResolvedValue(true);
    expect((await otpVerify(mk("/api/account/otp/verify", { email: "a@example.com", code: "123456" }, undefined, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("a new sign-in replaces the session the browser already held", async () => {
    const a = await signInCustomer();
    await age(a.email);
    await request(a.email);
    const r = await read(await verify({ email: a.email, code: lastCode(a.email) }, a.cookie));
    const fresh = r.setCookie!.split(";")[0];
    expect(fresh).not.toBe(a.cookie);
    expect((await me(mk("/api/account/me", undefined, a.cookie))).status).toBe(401);
    expect((await me(mk("/api/account/me", undefined, fresh))).status).toBe(200);
  });
});

describe("customer sessions", () => {
  const live = async (cookie: string) => (await me(mk("/api/account/me", undefined, cookie))).status;

  it("stores only a keyed hash of the token", async () => {
    const c = await signInCustomer();
    const row = await db.customerSession.findFirstOrThrow({ where: { customerId: c.customerId } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(c.token);
  });

  it("logout revokes server-side; 'everywhere' ends every session", async () => {
    const c = await signInCustomer();
    expect(await live(c.cookie)).toBe(200);
    const out = await read(await logout(mk("/api/account/logout", {}, c.cookie)));
    expect(out.status).toBe(200);
    expect(out.setCookie).toMatch(new RegExp(`${CUSTOMER_COOKIE}=;`));
    expect(await live(c.cookie)).toBe(401);
    await age(c.email);
    const a = await signInCustomer(c.email);
    await age(c.email);
    const b = await signInCustomer(c.email);
    expect([await live(a.cookie), await live(b.cookie)]).toEqual([200, 200]);
    await logout(mk("/api/account/logout", { everywhere: true }, a.cookie));
    expect([await live(a.cookie), await live(b.cookie)]).toEqual([401, 401]);
    expect((await logout(mk("/api/account/logout", {}))).status).toBe(200); // harmless without a session
  });

  it.each([
    ["absolute expiry", (id: string) => db.customerSession.updateMany({ where: { customerId: id }, data: { expiresAt: new Date(Date.now() - 1000) } })],
    ["idle timeout", (id: string) => db.customerSession.updateMany({ where: { customerId: id }, data: { lastSeenAt: new Date(Date.now() - CUSTOMER_SESSION_IDLE_MS - 60_000) } })],
    ["revocation", (id: string) => db.customerSession.updateMany({ where: { customerId: id }, data: { revokedAt: new Date() } })],
  ])("rejects a session after %s", async (_n, kill) => {
    const c = await signInCustomer();
    expect(await live(c.cookie)).toBe(200);
    await kill(c.customerId);
    expect(await live(c.cookie)).toBe(401);
  });

  it("rejects tampered, empty, foreign and admin cookies", async () => {
    const c = await signInCustomer();
    for (const bad of [`${CUSTOMER_COOKIE}=${c.token}x`, `${CUSTOMER_COOKIE}=`, "other=1", `vv_admin=${c.token}`, ""]) expect(await live(bad)).toBe(401);
    expect(await live(`a=1; ${CUSTOMER_COOKIE}=${c.token}`)).toBe(200);
  });

  it("a customer cookie is not an admin session and an admin cookie is not a customer session", async () => {
    const c = await signInCustomer();
    const { createTestAdmin } = await import("../support/admin");
    const admin = await createTestAdmin("owner");
    expect(await live(admin.cookie)).toBe(401);
    const { GET: adminMe } = await import("@/app/api/admin/me/route");
    expect((await adminMe(new Request("http://localhost/api/admin/me", { headers: { cookie: c.cookie } }))).status).toBe(401);
    const { cleanupAdminFixtures } = await import("../support/admin");
    await cleanupAdminFixtures();
  });
});

describe("service-level edge cases", () => {
  it("issueOtp/verifyOtp normalise the address (case, whitespace)", async () => {
    const email = freshEmail();
    expect(await issueOtp(`  ${email.toUpperCase()}  `)).toEqual({ ok: true });
    const r = await verifyOtp({ email: ` ${email} `, code: lastCode(email), acceptTerms: true });
    expect(r.ok).toBe(true);
  });
});
