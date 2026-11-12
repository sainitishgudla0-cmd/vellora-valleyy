/** M4: login, sessions, lockout, CSRF/origin, legacy transition login and audit, through the real route handlers and Postgres. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { LOCK_MS, MAX_FAILED_LOGINS } from "@/lib/auth/login";
import { SESSION_COOKIE, SESSION_IDLE_MS } from "@/lib/auth/admin";
import { cleanupAdminFixtures, createLegacySession, createTestAdmin, ensureSessionSecret, TEST_ADMIN_PASSWORD } from "../support/admin";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as login } from "@/app/api/admin/login/route";
import { POST as logout } from "@/app/api/admin/logout/route";
import { GET as me } from "@/app/api/admin/me/route";
import { PATCH as patchEnquiry } from "@/app/api/admin/enquiries/[id]/route";
import { GET as sessionsList } from "@/app/api/admin/sessions/route";
import { DELETE as sessionRevoke } from "@/app/api/admin/sessions/[id]/route";
import { POST as changePassword } from "@/app/api/admin/account/password/route";
import { GET as usersList } from "@/app/api/admin/users/route";

const LEGACY_PASSWORD = "legacy-shared-password-for-tests-only";
type Init = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };
const mk = (url: string, i: Init = {}) =>
  new Request(`http://localhost${url}`, { method: i.method ?? "POST", headers: { ...(i.cookie ? { cookie: i.cookie } : {}), host: "localhost", ...i.headers }, body: i.body === undefined ? undefined : JSON.stringify(i.body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any>, setCookie: res.headers.get("set-cookie") });
const doLogin = (body: unknown, i: Init = {}) => login(mk("/api/admin/login", { ...i, body }));
const cookieOf = (setCookie: string | null) => setCookie?.split(";")[0] ?? "";
const audit = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

let owner: Awaited<ReturnType<typeof createTestAdmin>>;
beforeEach(async () => {
  ensureSessionSecret();
  vi.stubEnv("ADMIN_PASSWORD", LEGACY_PASSWORD);
  vi.stubEnv("ADMIN_LEGACY_LOGIN", "");
  vi.stubEnv("ADMIN_ALLOWED_ORIGINS", "");
  rate.rateLimit.mockResolvedValue(true);
  await db.auditLog.deleteMany({});
  owner = await createTestAdmin("owner");
});
afterAll(async () => {
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("login", () => {
  it("signs in with email + password and sets an HttpOnly, SameSite=Lax session cookie", async () => {
    const r = await read(await doLogin({ email: owner.email.toUpperCase(), password: owner.password }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, role: "owner" } });
    expect(r.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{40,};`));
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=lax/i);
    expect(r.setCookie).toMatch(/Path=\//);
    expect(r.setCookie).toMatch(/Max-Age=28800/);
    expect(JSON.stringify(r.body)).not.toContain(cookieOf(r.setCookie).split("=")[1]);
    expect((await read(await me(mk("/api/admin/me", { method: "GET", cookie: cookieOf(r.setCookie) })))).body).toMatchObject({ email: owner.email, role: "owner", legacy: false });
    expect((await audit("login.success"))[0]).toMatchObject({ outcome: "success", actorLabel: owner.email, actorRole: "owner" });
  });

  it("wrong password, unknown account and disabled account all look identical to the caller", async () => {
    const wrong = await read(await doLogin({ email: owner.email, password: "definitely not the password" }));
    const unknown = await read(await doLogin({ email: "nobody@m4-fixture.example.com", password: "definitely not the password" }));
    await db.adminUser.update({ where: { id: owner.user.id }, data: { active: false } });
    const disabled = await read(await doLogin({ email: owner.email, password: owner.password }));
    for (const r of [wrong, unknown, disabled]) expect(r).toEqual({ status: 401, body: { error: "Incorrect email or password" }, setCookie: null });
    const reasons = (await audit("login.failure")).map((a) => JSON.parse(a.details!).reason);
    expect(reasons).toEqual(["bad_password", "unknown_account", "disabled"]);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("definitely not the password");
  });

  it("locks the account after repeated failures: even the right password is refused until the lock ends", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) expect((await doLogin({ email: owner.email, password: "wrong password here" })).status).toBe(401);
    const u = await db.adminUser.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(u.failedLogins).toBe(MAX_FAILED_LOGINS);
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + LOCK_MS - 5000);
    const locked = await read(await doLogin({ email: owner.email, password: owner.password }));
    expect(locked).toEqual({ status: 401, body: { error: "Incorrect email or password" }, setCookie: null });
    expect((await audit("login.locked")).length).toBe(1);
    expect(JSON.parse((await audit("login.failure")).at(-1)!.details!).reason).toBe("locked");
    // the lock expires
    await db.adminUser.update({ where: { id: owner.user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(200);
    expect(await db.adminUser.findUniqueOrThrow({ where: { id: owner.user.id } })).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it("a success resets the failure counter", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) await doLogin({ email: owner.email, password: "wrong password here" });
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(200);
    expect((await db.adminUser.findUniqueOrThrow({ where: { id: owner.user.id } })).failedLogins).toBe(0);
    await doLogin({ email: owner.email, password: "wrong password here" });
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(200); // far from the limit again
  });

  it("validates input and honours the IP rate limit", async () => {
    expect((await doLogin({ password: "" })).status).toBe(422);
    expect((await doLogin({ email: "x".repeat(300), password: "p" })).status).toBe(422);
    expect((await login(new Request("http://localhost/api/admin/login", { method: "POST", body: "not json" }))).status).toBe(400);
    rate.rateLimit.mockResolvedValue(false);
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(429);
  });

  it("503 when SESSION_SECRET is missing", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(503);
  });

  it("a new login replaces the session the browser already held (no fixation)", async () => {
    const first = cookieOf((await read(await doLogin({ email: owner.email, password: owner.password }))).setCookie);
    const second = cookieOf((await read(await doLogin({ email: owner.email, password: owner.password }, { cookie: first }))).setCookie);
    expect(second).not.toBe(first);
    expect((await me(mk("/api/admin/me", { method: "GET", cookie: first }))).status).toBe(401);
    expect((await me(mk("/api/admin/me", { method: "GET", cookie: second }))).status).toBe(200);
  });
});

describe("sessions", () => {
  const live = async (cookie: string) => (await me(mk("/api/admin/me", { method: "GET", cookie }))).status;

  it("stores only a keyed hash of the token", async () => {
    const row = await db.adminSession.findUniqueOrThrow({ where: { id: owner.sessionId } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(owner.token);
  });

  it("logout revokes server-side: the same cookie is dead afterwards", async () => {
    expect(await live(owner.cookie)).toBe(200);
    const out = await read(await logout(mk("/api/admin/logout", { cookie: owner.cookie })));
    expect(out.status).toBe(200);
    expect(out.setCookie).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect((await db.adminSession.findUniqueOrThrow({ where: { id: owner.sessionId } })).revokedAt).not.toBeNull();
    expect(await live(owner.cookie)).toBe(401); // a copied cookie is useless
    expect((await audit("logout")).length).toBe(1);
  });

  it("logout without a session is harmless", async () => {
    expect((await logout(mk("/api/admin/logout"))).status).toBe(200);
  });

  it.each([
    ["absolute expiry", () => db.adminSession.update({ where: { id: owner.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } })],
    ["idle timeout", () => db.adminSession.update({ where: { id: owner.sessionId }, data: { lastSeenAt: new Date(Date.now() - SESSION_IDLE_MS - 60_000) } })],
    ["revocation", () => db.adminSession.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date() } })],
    ["account deactivation", () => db.adminUser.update({ where: { id: owner.user.id }, data: { active: false } })],
  ])("rejects a session after %s", async (_name, kill) => {
    expect(await live(owner.cookie)).toBe(200);
    await kill();
    expect(await live(owner.cookie)).toBe(401);
  });

  it("rejects tampered, empty and foreign cookies", async () => {
    for (const c of [`${SESSION_COOKIE}=${owner.token}x`, `${SESSION_COOKIE}=`, `${SESSION_COOKIE}=garbage`, `other=${owner.token}`, "", `a=1; ${SESSION_COOKIE}=nope`]) expect(await live(c)).toBe(401);
    expect(await live(`a=1; ${SESSION_COOKIE}=${owner.token}; b=2`)).toBe(200);
  });

  it("an old HMAC-style cookie from before M4 is simply invalid", async () => {
    expect(await live(`${SESSION_COOKIE}=admin.9999999999.abc`)).toBe(401);
  });

  it("lists your sessions (never tokens), owners may list all, others cannot see or revoke foreign ones", async () => {
    const ops = await createTestAdmin("operations");
    const mine = await read(await sessionsList(mk("/api/admin/sessions", { method: "GET", cookie: ops.cookie })));
    expect(mine.body.sessions.map((s: any) => s.id)).toEqual([ops.sessionId]);
    expect(mine.body.sessions[0]).toMatchObject({ current: true, email: ops.email });
    expect(JSON.stringify(mine.body)).not.toMatch(/tokenHash|token"/);
    const everyone = await read(await sessionsList(mk("/api/admin/sessions?all=1", { method: "GET", cookie: owner.cookie })));
    expect(everyone.body.sessions.map((s: any) => s.id)).toEqual(expect.arrayContaining([owner.sessionId, ops.sessionId]));
    const asOps = await read(await sessionsList(mk("/api/admin/sessions?all=1", { method: "GET", cookie: ops.cookie })));
    expect(asOps.body.sessions).toHaveLength(1); // ?all is ignored without permission
    expect((await sessionRevoke(mk(`/api/admin/sessions/${owner.sessionId}`, { method: "DELETE", cookie: ops.cookie }), { params: Promise.resolve({ id: owner.sessionId }) })).status).toBe(404);
    expect(await live(owner.cookie)).toBe(200);
    expect((await sessionRevoke(mk(`/api/admin/sessions/${ops.sessionId}`, { method: "DELETE", cookie: owner.cookie }), { params: Promise.resolve({ id: ops.sessionId }) })).status).toBe(200);
    expect(await live(ops.cookie)).toBe(401);
    expect((await audit("session.revoke")).map((a) => a.outcome)).toEqual(["success"]); // the refused attempt on a foreign session is a 404, not a mutation
  });

  it("password change needs the current password, enforces the policy, and ends every other session", async () => {
    const other = await db.adminSession.count({ where: { userId: owner.user.id } });
    const second = cookieOf((await read(await doLogin({ email: owner.email, password: owner.password }))).setCookie);
    expect(other).toBe(1);
    const call = (body: unknown, cookie = second) => changePassword(mk("/api/admin/account/password", { cookie, body }));
    expect((await call({ currentPassword: "wrong wrong wrong", newPassword: "a brand new passphrase 77" })).status).toBe(422);
    expect((await call({ currentPassword: owner.password, newPassword: "short" })).status).toBe(422);
    const ok = await read(await call({ currentPassword: owner.password, newPassword: "a brand new passphrase 77" }));
    expect(ok).toMatchObject({ status: 200, body: { ok: true, sessionsRevoked: 1 } }); // the fixture session
    expect(await live(owner.cookie)).toBe(401);
    expect(await live(second)).toBe(200); // the session in use survives
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(401); // old password is gone
    expect((await doLogin({ email: owner.email, password: "a brand new passphrase 77" })).status).toBe(200);
    expect((await audit("password.change")).map((a) => a.outcome)).toEqual(["rejected", "rejected", "success"]);
  });

  it("password change ends the user's other live sessions", async () => {
    const a = cookieOf((await read(await doLogin({ email: owner.email, password: owner.password }))).setCookie);
    const b = cookieOf((await read(await doLogin({ email: owner.email, password: owner.password }))).setCookie);
    expect(await live(owner.cookie)).toBe(200);
    const res = await changePassword(mk("/api/admin/account/password", { cookie: b, body: { currentPassword: owner.password, newPassword: "yet another long passphrase" } }));
    expect((await res.json()).sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await live(a)).toBe(401);
    expect(await live(owner.cookie)).toBe(401);
    expect(await live(b)).toBe(200);
  });
});

describe("cross-origin (CSRF) protection", () => {
  const evil = { origin: "https://evil.example" };
  const enquiry = async () => (await db.enquiry.create({ data: { type: "contact", name: "SMOKE TEST csrf", email: "smoke.csrf@example.com", message: "m" } })).id;

  it("refuses cross-origin mutations (login, logout, admin PATCH) with 403 and changes nothing", async () => {
    const id = await enquiry();
    const patch = (headers: Record<string, string>) => patchEnquiry(mk(`/api/admin/enquiries/${id}`, { method: "PATCH", cookie: owner.cookie, headers, body: { status: "closed" } }), { params: Promise.resolve({ id }) });
    expect((await patch(evil)).status).toBe(403);
    expect((await patch({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await db.enquiry.findUniqueOrThrow({ where: { id } })).status).toBe("new");
    expect((await doLogin({ email: owner.email, password: owner.password }, { headers: evil })).status).toBe(403);
    const out = await logout(mk("/api/admin/logout", { cookie: owner.cookie, headers: evil }));
    expect(out.status).toBe(403);
    expect((await db.adminSession.findUniqueOrThrow({ where: { id: owner.sessionId } })).revokedAt).toBeNull();
    // same-origin and header-less (script) requests work
    expect((await patch({ origin: "http://localhost" })).status).toBe(200);
    expect((await patch({})).status).toBe(200);
    expect((await audit("request.cross_origin")).length).toBeGreaterThanOrEqual(1);
  });

  it("reads are not origin-checked, and ADMIN_ALLOWED_ORIGINS admits a named extra origin", async () => {
    expect((await me(mk("/api/admin/me", { method: "GET", cookie: owner.cookie, headers: evil }))).status).toBe(200);
    const id = await enquiry();
    vi.stubEnv("ADMIN_ALLOWED_ORIGINS", "https://admin.example");
    const res = await patchEnquiry(mk(`/api/admin/enquiries/${id}`, { method: "PATCH", cookie: owner.cookie, headers: { origin: "https://admin.example" }, body: { status: "closed" } }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
  });
});

describe("shared ADMIN_PASSWORD transition login", () => {
  it("still works without an email (the unchanged dashboard form), as an owner-level session that cannot manage users", async () => {
    const r = await read(await doLogin({ password: LEGACY_PASSWORD }));
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    const cookie = cookieOf(r.setCookie);
    expect((await read(await me(mk("/api/admin/me", { method: "GET", cookie })))).body).toMatchObject({ email: null, role: "owner", legacy: true });
    const id = (await db.enquiry.create({ data: { type: "contact", name: "SMOKE TEST legacy", email: "smoke.legacy@example.com", message: "m" } })).id;
    expect((await patchEnquiry(mk(`/api/admin/enquiries/${id}`, { method: "PATCH", cookie, body: { status: "closed" } }), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect((await usersList(mk("/api/admin/users", { method: "GET", cookie }))).status).toBe(403);
    expect((await changePassword(mk("/api/admin/account/password", { cookie, body: { currentPassword: "x", newPassword: "y" } }))).status).toBe(409);
    expect((await audit("order.update")).length + (await audit("enquiry.update")).filter((a) => a.actorLabel === "legacy").length).toBe(1);
  });

  it("wrong shared password is a 401; ADMIN_LEGACY_LOGIN=off disables it and ends live legacy sessions", async () => {
    expect((await doLogin({ password: "not the shared password" })).status).toBe(401);
    const live = await createLegacySession();
    expect((await me(mk("/api/admin/me", { method: "GET", cookie: live.cookie }))).status).toBe(200);
    vi.stubEnv("ADMIN_LEGACY_LOGIN", "off");
    expect((await doLogin({ password: LEGACY_PASSWORD })).status).toBe(401);
    expect((await me(mk("/api/admin/me", { method: "GET", cookie: live.cookie }))).status).toBe(401);
    expect((await doLogin({ email: owner.email, password: owner.password })).status).toBe(200); // accounts are unaffected
  });

  it("is off when ADMIN_PASSWORD is not set", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect((await doLogin({ password: "" })).status).toBe(422);
    expect((await doLogin({ password: "anything at all" })).status).toBe(401);
  });
});

describe("TEST_ADMIN_PASSWORD fixture", () => {
  it("meets the password policy (guards against fixture drift)", () => {
    expect(TEST_ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(12);
  });
});
