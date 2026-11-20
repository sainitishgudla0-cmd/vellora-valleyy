/**
 * M11 P1-T5 (F05): the shared ADMIN_PASSWORD session is read-only (plus enquiry replies) and is always off in
 * production; owner recovery is one audited transaction that also ends every shared-password session.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { recoverOwner } from "@/lib/auth/users";
import { verifyPassword } from "@/lib/auth/password";
import { cleanupAdminFixtures, createLegacySession, createTestAdmin } from "../support/admin";
import { cleanupFixtures, createFixtureOrder } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { GET as me } from "@/app/api/admin/me/route";
import { POST as login } from "@/app/api/admin/login/route";
import { PATCH as patchOrder } from "@/app/api/admin/orders/[id]/route";
import { PATCH as patchVariant } from "@/app/api/admin/variants/[id]/route";
import { POST as createTaxRate } from "@/app/api/admin/tax-rates/route";
import { DELETE as deleteTestData } from "@/app/api/admin/test-data/route";
import { POST as issueInvoice } from "@/app/api/admin/orders/[id]/invoice/route";
import { GET as auditLog } from "@/app/api/admin/audit/route";

const SHARED = "legacy-shared-password-for-p1t5-tests";
const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("ADMIN_PASSWORD", SHARED);
  vi.stubEnv("ADMIN_LEGACY_LOGIN", "");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("shared-password session outside production", () => {
  it("can sign in and read, but every money, price, tax, invoice, test-data and account change is 403 and changes nothing", async () => {
    const legacy = await createLegacySession();
    const meRes = await me(req("/api/admin/me", "GET", legacy.cookie));
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).permissions).toEqual(["admin:read", "enquiries:write", "wholesale:read", "fulfilment:read"]);

    const order = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "confirmed", paymentStatus: "unpaid" });
    const variant = await db.variant.findFirstOrThrow({ select: { id: true, price: true } });
    expect((await patchOrder(req("/api/admin/orders/x", "PATCH", legacy.cookie, { status: "dispatched" }), ctx(order.id))).status).toBe(403);
    expect((await patchVariant(req("/api/admin/variants/x", "PATCH", legacy.cookie, { price: 1 }), ctx(variant.id))).status).toBe(403);
    expect((await createTaxRate(req("/api/admin/tax-rates", "POST", legacy.cookie, { code: "0801", rateBp: 500, effectiveFrom: "2030-01-01" }))).status).toBe(403);
    expect((await deleteTestData(req("/api/admin/test-data", "DELETE", legacy.cookie))).status).toBe(403);
    expect((await issueInvoice(req("/api/admin/orders/x/invoice", "POST", legacy.cookie, {}), ctx(order.id))).status).toBe(403);
    expect((await auditLog(req("/api/admin/audit", "GET", legacy.cookie))).status).toBe(403);

    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("confirmed");
    expect((await db.variant.findUniqueOrThrow({ where: { id: variant.id } })).price).toBe(variant.price);
    expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(0);
    const denied = await db.auditLog.findMany({ where: { action: "access.denied", actorLabel: "legacy" }, orderBy: { createdAt: "desc" }, take: 6 });
    expect(denied.map((d) => JSON.parse(d.details!).permission).sort()).toEqual(["fulfilment:write", "orders:write", "tax:write", "testdata:write", "users:manage", "variants:write"].sort());
  });

  it("ADMIN_LEGACY_LOGIN=off disables the login and ends live shared-password sessions", async () => {
    const legacy = await createLegacySession();
    vi.stubEnv("ADMIN_LEGACY_LOGIN", "off");
    expect((await me(req("/api/admin/me", "GET", legacy.cookie))).status).toBe(401);
    expect((await login(req("/api/admin/login", "POST", undefined, { password: SHARED }))).status).toBe(401);
  });
});

describe("production", () => {
  it("the shared-password login is refused and live shared-password sessions die, even with ADMIN_PASSWORD set", async () => {
    const legacy = await createLegacySession();
    expect((await me(req("/api/admin/me", "GET", legacy.cookie))).status).toBe(200);
    vi.stubEnv("APP_ENV", "production");
    expect((await me(req("/api/admin/me", "GET", legacy.cookie))).status).toBe(401);
    expect((await login(req("/api/admin/login", "POST", undefined, { password: SHARED }))).status).toBe(401);
    const failure = await db.auditLog.findFirstOrThrow({ where: { action: "login.failure" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(failure.details!)).toMatchObject({ reason: "legacy_disabled" });
  });

  it("an environment that cannot be resolved counts as production (fail closed)", async () => {
    vi.stubEnv("APP_ENV", "staging-ish");
    expect((await login(req("/api/admin/login", "POST", undefined, { password: SHARED }))).status).toBe(401);
  });

  it("individual owner accounts keep working in production", async () => {
    const owner = await createTestAdmin("owner");
    vi.stubEnv("APP_ENV", "production");
    expect((await me(req("/api/admin/me", "GET", owner.cookie))).status).toBe(200);
  });
});

describe("owner recovery (admin:bootstrap --reset)", () => {
  const actor = { userId: null, label: "bootstrap-script", role: "owner" };

  it("replaces the password, reactivates and unlocks, ends the owner's and every shared-password session, and audits it in one transaction", async () => {
    const owner = await createTestAdmin("owner");
    await db.adminUser.update({ where: { id: owner.user.id }, data: { active: false, failedLogins: 9, lockedUntil: new Date(Date.now() + 3_600_000) } });
    const legacyA = await createLegacySession();
    const legacyB = await createLegacySession();
    const r = await recoverOwner(owner.email, "recovered owner passphrase 314", actor);
    expect(r).toMatchObject({ ok: true, sessionsRevoked: 1, reactivated: true });
    expect(r.ok && r.legacySessionsRevoked).toBeGreaterThanOrEqual(2);
    const u = await db.adminUser.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(u).toMatchObject({ active: true, failedLogins: 0, lockedUntil: null });
    expect(await verifyPassword("recovered owner passphrase 314", u.passwordHash)).toBe(true);
    for (const c of [owner.cookie, legacyA.cookie, legacyB.cookie]) expect((await me(req("/api/admin/me", "GET", c))).status).toBe(401);
    const rows = await db.auditLog.findMany({ where: { action: "owner.recover", targetId: owner.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", actorLabel: "bootstrap-script" });
  });

  it("refuses non-owners, unknown emails and weak passwords without changing anything", async () => {
    const viewer = await createTestAdmin("viewer");
    expect(await recoverOwner(viewer.email, "recovered owner passphrase 314", actor)).toMatchObject({ ok: false, code: "not_found" });
    expect(await recoverOwner("nobody@m4-fixture.example.com", "recovered owner passphrase 314", actor)).toMatchObject({ ok: false, code: "not_found" });
    const owner = await createTestAdmin("owner");
    expect(await recoverOwner(owner.email, "short", actor)).toMatchObject({ ok: false, code: "weak_password" });
    expect((await me(req("/api/admin/me", "GET", owner.cookie))).status).toBe(200);
    expect(await verifyPassword(owner.password, (await db.adminUser.findUniqueOrThrow({ where: { id: viewer.user.id } })).passwordHash)).toBe(true);
  });

  it("rolls back entirely if the audit row cannot be written", async () => {
    const owner = await createTestAdmin("owner");
    const name = `vv_recover_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."action" = 'owner.recover') EXECUTE FUNCTION ${name}()`);
    try {
      await expect(recoverOwner(owner.email, "recovered owner passphrase 314", actor)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    expect(await verifyPassword(owner.password, (await db.adminUser.findUniqueOrThrow({ where: { id: owner.user.id } })).passwordHash)).toBe(true);
    expect((await me(req("/api/admin/me", "GET", owner.cookie))).status).toBe(200);
  });
});
