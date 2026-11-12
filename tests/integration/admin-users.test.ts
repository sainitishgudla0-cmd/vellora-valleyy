/** M4: role × route matrix, account management, last-owner protection, audit completeness and the bootstrap script. */
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { cleanupAdminFixtures, createTestAdmin, ensureSessionSecret, FIXTURE_EMAIL_DOMAIN, TEST_ADMIN_PASSWORD } from "../support/admin";
import { cleanupFixtures, createFixtureOrder } from "../support/mock-orders";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { createSession, SESSION_COOKIE } from "@/lib/auth/admin";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as login } from "@/app/api/admin/login/route";
import { POST as logout } from "@/app/api/admin/logout/route";
import { GET as me } from "@/app/api/admin/me/route";
import { PATCH as patchOrder } from "@/app/api/admin/orders/[id]/route";
import { PATCH as patchEnquiry } from "@/app/api/admin/enquiries/[id]/route";
import { PATCH as patchVariant } from "@/app/api/admin/variants/[id]/route";
import { GET as lowStock } from "@/app/api/admin/variants/low-stock/route";
import { DELETE as removeTestData } from "@/app/api/admin/test-data/route";
import { GET as usersList, POST as usersCreate } from "@/app/api/admin/users/route";
import { PATCH as usersPatch } from "@/app/api/admin/users/[id]/route";
import { GET as auditList } from "@/app/api/admin/audit/route";
import { GET as sessionsList } from "@/app/api/admin/sessions/route";
import { DELETE as sessionRevoke } from "@/app/api/admin/sessions/[id]/route";
import { POST as changePassword } from "@/app/api/admin/account/password/route";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
const mk = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const audit = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
const fresh = () => `new-${Math.random().toString(36).slice(2, 10)}@${FIXTURE_EMAIL_DOMAIN}`;

let owner: Admin;
beforeEach(async () => {
  ensureSessionSecret();
  vi.stubEnv("ADMIN_PASSWORD", "");
  rate.rateLimit.mockResolvedValue(true);
  await db.auditLog.deleteMany({});
  await db.adminUser.deleteMany({}); // disposable database: start every test with exactly the accounts it creates
  owner = await createTestAdmin("owner");
});
afterAll(async () => {
  await cleanupAdminFixtures();
  await cleanupFixtures();
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("role × route matrix (403 for role violations, 401 without a session)", () => {
  const ROLES: AdminRole[] = ["owner", "operations", "catalog", "viewer"];
  // [name, who may use it, how to call it]
  const ROUTES: [string, AdminRole[], (cookie?: string) => Promise<Response>][] = [
    ["PATCH orders/[id]", ["owner", "operations"], (c) => patchOrder(mk("/api/admin/orders/none", "PATCH", c, { status: "confirmed" }), ctx("none"))],
    ["PATCH enquiries/[id]", ["owner", "operations"], (c) => patchEnquiry(mk("/api/admin/enquiries/none", "PATCH", c, { status: "closed" }), ctx("none"))],
    ["PATCH variants/[id] price", ["owner", "catalog"], (c) => patchVariant(mk("/api/admin/variants/none", "PATCH", c, { price: 10 }), ctx("none"))],
    ["PATCH variants/[id] inStock", ["owner", "catalog"], (c) => patchVariant(mk("/api/admin/variants/none", "PATCH", c, { inStock: false }), ctx("none"))],
    ["PATCH variants/[id] stockAdjust", ["owner", "operations", "catalog"], (c) => patchVariant(mk("/api/admin/variants/none", "PATCH", c, { stockAdjust: { delta: 1, reason: "matrix" } }), ctx("none"))],
    ["PATCH variants/[id] price+stock", ["owner", "catalog"], (c) => patchVariant(mk("/api/admin/variants/none", "PATCH", c, { price: 10, stockAdjust: { delta: 1, reason: "matrix" } }), ctx("none"))],
    ["GET variants/low-stock", ROLES, (c) => lowStock(mk("/api/admin/variants/low-stock", "GET", c))],
    ["DELETE test-data", ["owner"], (c) => removeTestData(mk("/api/admin/test-data", "DELETE", c))],
    ["GET users", ["owner"], (c) => usersList(mk("/api/admin/users", "GET", c))],
    ["POST users", ["owner"], (c) => usersCreate(mk("/api/admin/users", "POST", c, { email: fresh(), name: "Matrix", role: "viewer", password: TEST_ADMIN_PASSWORD }))],
    ["PATCH users/[id]", ["owner"], (c) => usersPatch(mk("/api/admin/users/none", "PATCH", c, { active: true }), ctx("none"))],
    ["GET audit", ["owner"], (c) => auditList(mk("/api/admin/audit", "GET", c))],
    ["GET sessions", ROLES, (c) => sessionsList(mk("/api/admin/sessions", "GET", c))],
    ["DELETE sessions/[id]", ROLES, (c) => sessionRevoke(mk("/api/admin/sessions/none", "DELETE", c), ctx("none"))],
    ["GET me", ROLES, (c) => me(mk("/api/admin/me", "GET", c))],
    ["POST account/password", ROLES, (c) => changePassword(mk("/api/admin/account/password", "POST", c, { currentPassword: "x", newPassword: "y" }))],
  ];

  it.each(ROUTES)("%s", async (_name, allowed, call) => {
    expect((await call()).status).toBe(401);
    for (const role of ROLES) {
      const who = role === "owner" ? owner : await createTestAdmin(role);
      const status = (await call(who.cookie)).status;
      if (allowed.includes(role)) expect([401, 403], `${role} should be allowed`).not.toContain(status);
      else expect(status, `${role} should be refused`).toBe(403);
    }
  });

  it("every refusal is audited with the actor and the permission that was missing", async () => {
    const viewer = await createTestAdmin("viewer");
    await patchOrder(mk("/api/admin/orders/none", "PATCH", viewer.cookie, { status: "confirmed" }), ctx("none"));
    const [row] = await audit("access.denied");
    expect(row).toMatchObject({ outcome: "denied", actorLabel: viewer.email, actorRole: "viewer", actorUserId: viewer.user.id });
    expect(JSON.parse(row.details!)).toEqual({ permission: "orders:write", method: "PATCH" });
  });

  it("the refused route did nothing: a viewer cannot change an order", async () => {
    const viewer = await createTestAdmin("viewer");
    const o = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation" });
    expect((await patchOrder(mk(`/api/admin/orders/${o.id}`, "PATCH", viewer.cookie, { status: "confirmed" }), ctx(o.id))).status).toBe(403);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("pending_confirmation");
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });
});

describe("audit completeness: every admin mutation leaves a row, without secrets", () => {
  it("covers each mutating route and keeps free text, passwords and tokens out of the log", async () => {
    const o = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation" });
    await db.payment.create({ data: { orderId: o.id, provider: "request_only", mode: "request_only", amount: o.total, currency: "INR" } });
    const enq = await db.enquiry.create({ data: { type: "contact", name: "SMOKE TEST audit", email: "smoke.audit@example.com", message: "m" } });
    const v = await db.variant.findUniqueOrThrow({ where: { id: (await createInventoryVariant({ tracked: false })).variantId } });
    const target = await createTestAdmin("viewer");
    const SECRET_REASON = "Customer asked on WhatsApp about SECRET-REASON-TEXT";

    await patchOrder(mk(`/api/admin/orders/${o.id}`, "PATCH", owner.cookie, { status: "confirmed", reason: SECRET_REASON }), ctx(o.id));
    // the order change itself carries the (non-secret) actor on the OrderEvent (read before test-data cleanup removes the order)
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id } })).actorId).toBe(owner.user.id);
    await patchOrder(mk(`/api/admin/orders/${o.id}`, "PATCH", owner.cookie, { status: "pending_confirmation" }), ctx(o.id)); // invalid: rejected
    await patchEnquiry(mk(`/api/admin/enquiries/${enq.id}`, "PATCH", owner.cookie, { status: "closed" }), ctx(enq.id));
    await patchVariant(mk(`/api/admin/variants/${v.id}`, "PATCH", owner.cookie, { price: v.price / 100 }), ctx(v.id));
    await usersCreate(mk("/api/admin/users", "POST", owner.cookie, { email: fresh(), name: "Audited", role: "catalog", password: "SECRET-PASSWORD-VALUE-123" }));
    await sessionRevoke(mk(`/api/admin/sessions/${target.sessionId}`, "DELETE", owner.cookie), ctx(target.sessionId));
    await usersPatch(mk(`/api/admin/users/${target.user.id}`, "PATCH", owner.cookie, { role: "catalog", password: "ANOTHER-SECRET-PASSWORD-9" }), ctx(target.user.id));
    await changePassword(mk("/api/admin/account/password", "POST", owner.cookie, { currentPassword: owner.password, newPassword: "owner-new-SECRET-passphrase-1" }));
    const second = await createTestAdmin("owner");
    await removeTestData(mk("/api/admin/test-data", "DELETE", second.cookie));
    await logout(mk("/api/admin/logout", "POST", second.cookie));

    const rows = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    const seen = rows.map((r) => `${r.action}:${r.outcome}`);
    for (const expected of ["order.update:success", "order.update:rejected", "enquiry.update:success", "variant.update:success", "user.create:success", "user.update:success", "session.revoke:success", "password.change:success", "testdata.delete:success", "logout:success"])
      expect(seen, expected).toContain(expected);
    expect(rows.find((r) => r.action === "order.update" && r.outcome === "success")).toMatchObject({ actorUserId: owner.user.id, actorLabel: owner.email, targetType: "order", targetId: o.id });
    const everything = JSON.stringify(rows);
    for (const secret of ["SECRET-REASON-TEXT", "SECRET-PASSWORD-VALUE", "ANOTHER-SECRET-PASSWORD", "owner-new-SECRET", owner.token, owner.password, "passwordHash", "scrypt$"]) expect(everything, secret).not.toContain(secret);
  });

  it("audit rows are append-only from the API: there is no route to edit or delete them", async () => {
    const res = await auditList(mk("/api/admin/audit?limit=5", "GET", owner.cookie));
    expect(res.status).toBe(200);
    // the read route exposes GET only
    const mod = await import("@/app/api/admin/audit/route");
    expect(Object.keys(mod).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });

  it("owners can page the log newest first and filter by action; others cannot read it", async () => {
    for (let i = 0; i < 3; i++) await login(mk("/api/admin/login", "POST", undefined, { email: owner.email, password: "wrong wrong wrong" }));
    const all = await read(await auditList(mk("/api/admin/audit?limit=2", "GET", owner.cookie)));
    expect(all.body.entries).toHaveLength(2);
    expect(new Date(all.body.entries[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(all.body.entries[1].createdAt).getTime());
    const failures = await read(await auditList(mk("/api/admin/audit?action=login.failure", "GET", owner.cookie)));
    expect(failures.body.entries).toHaveLength(3);
    const older = await read(await auditList(mk(`/api/admin/audit?before=${encodeURIComponent(failures.body.entries[0].createdAt)}&action=login.failure`, "GET", owner.cookie)));
    expect(older.body.entries).toHaveLength(2);
    expect((await auditList(mk("/api/admin/audit?limit=0", "GET", owner.cookie))).status).toBe(422);
    expect((await auditList(mk("/api/admin/audit?before=yesterday", "GET", owner.cookie))).status).toBe(422);
    const ops = await createTestAdmin("operations");
    expect((await auditList(mk("/api/admin/audit", "GET", ops.cookie))).status).toBe(403);
  });
});

describe("account management", () => {
  const create = (body: Record<string, unknown>, cookie = owner.cookie) => usersCreate(mk("/api/admin/users", "POST", cookie, body));
  const valid = (over: Record<string, unknown> = {}) => ({ email: fresh(), name: "New Person", role: "operations", password: "a decent long passphrase", ...over });

  it("creates an account that can sign in, never returning the hash; emails are unique case-insensitively", async () => {
    const body = valid({ email: `  Mixed.Case@${FIXTURE_EMAIL_DOMAIN} ` });
    const r = await read(await create(body));
    expect(r).toMatchObject({ status: 201, body: { user: { email: `mixed.case@${FIXTURE_EMAIL_DOMAIN}`, role: "operations", active: true } } });
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|scrypt/);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: body.email, password: body.password }))).status).toBe(200);
    expect((await read(await create(valid({ email: `MIXED.CASE@${FIXTURE_EMAIL_DOMAIN}` })))).status).toBe(409);
    expect(JSON.stringify((await read(await usersList(mk("/api/admin/users", "GET", owner.cookie)))).body)).not.toMatch(/passwordHash|scrypt/);
  });

  it.each([
    ["weak password", { password: "short" }],
    ["password containing the email name", { email: `jonathan@${FIXTURE_EMAIL_DOMAIN}`, password: "jonathan-is-my-name" }],
    ["bad email", { email: "not-an-email" }],
    ["unknown role", { role: "superuser" }],
    ["unknown field", { isAdmin: true }],
    ["missing name", { name: "" }],
  ])("rejects %s with 422 and creates nothing", async (_n, over) => {
    const before = await db.adminUser.count();
    expect((await create(valid(over))).status).toBe(422);
    expect(await db.adminUser.count()).toBe(before);
  });

  it("changing role or deactivating ends the person's sessions at once", async () => {
    const staff = await createTestAdmin("operations");
    const r = await read(await usersPatch(mk(`/api/admin/users/${staff.user.id}`, "PATCH", owner.cookie, { role: "viewer" }), ctx(staff.user.id)));
    expect(r.body).toMatchObject({ ok: true, sessionsRevoked: 1 });
    expect((await me(mk("/api/admin/me", "GET", staff.cookie))).status).toBe(401);
    const back = (await login(mk("/api/admin/login", "POST", undefined, { email: staff.email, password: staff.password })));
    expect((await read(back)).body.role).toBe("viewer");
    const cookie = back.headers.get("set-cookie")!.split(";")[0];
    expect((await patchOrder(mk("/api/admin/orders/x", "PATCH", cookie, { status: "confirmed" }), ctx("x"))).status).toBe(403); // the new role applies
    await usersPatch(mk(`/api/admin/users/${staff.user.id}`, "PATCH", owner.cookie, { active: false }), ctx(staff.user.id));
    expect((await me(mk("/api/admin/me", "GET", cookie))).status).toBe(401);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: staff.email, password: staff.password }))).status).toBe(401);
  });

  it("a password reset ends sessions, clears a lock, and the old password stops working", async () => {
    const staff = await createTestAdmin("catalog");
    await db.adminUser.update({ where: { id: staff.user.id }, data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    const r = await read(await usersPatch(mk(`/api/admin/users/${staff.user.id}`, "PATCH", owner.cookie, { password: "a replacement passphrase 1" }), ctx(staff.user.id)));
    expect(r.body).toMatchObject({ ok: true, sessionsRevoked: 1 });
    expect((await me(mk("/api/admin/me", "GET", staff.cookie))).status).toBe(401);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: staff.email, password: staff.password }))).status).toBe(401);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: staff.email, password: "a replacement passphrase 1" }))).status).toBe(200);
    expect((await read(await usersPatch(mk(`/api/admin/users/${staff.user.id}`, "PATCH", owner.cookie, { password: "weak" }), ctx(staff.user.id)))).status).toBe(422);
  });

  it("unlock clears the lock without changing the password", async () => {
    const staff = await createTestAdmin("viewer");
    await db.adminUser.update({ where: { id: staff.user.id }, data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    await usersPatch(mk(`/api/admin/users/${staff.user.id}`, "PATCH", owner.cookie, { unlock: true }), ctx(staff.user.id));
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: staff.email, password: staff.password }))).status).toBe(200);
  });

  it("404 for an unknown account, 422 for an empty or unknown-field change", async () => {
    expect((await usersPatch(mk("/api/admin/users/none", "PATCH", owner.cookie, { active: false }), ctx("none"))).status).toBe(404);
    expect((await usersPatch(mk(`/api/admin/users/${owner.user.id}`, "PATCH", owner.cookie, {}), ctx(owner.user.id))).status).toBe(422);
    expect((await usersPatch(mk(`/api/admin/users/${owner.user.id}`, "PATCH", owner.cookie, { passwordHash: "x" }), ctx(owner.user.id))).status).toBe(422);
  });

  it("the last active owner can be neither demoted nor deactivated; with a second owner it can", async () => {
    const patch = (id: string, body: unknown) => usersPatch(mk(`/api/admin/users/${id}`, "PATCH", owner.cookie, body), ctx(id));
    expect(await read(await patch(owner.user.id, { role: "viewer" }))).toMatchObject({ status: 409, body: { code: "last_owner" } });
    expect(await read(await patch(owner.user.id, { active: false }))).toMatchObject({ status: 409, body: { code: "last_owner" } });
    expect((await me(mk("/api/admin/me", "GET", owner.cookie))).status).toBe(200);
    const second = await createTestAdmin("owner");
    expect((await patch(second.user.id, { active: false })).status).toBe(200);
    expect(await read(await patch(owner.user.id, { active: false }))).toMatchObject({ status: 409, body: { code: "last_owner" } }); // second is now inactive
    expect((await patch(second.user.id, { active: true })).status).toBe(200);
    expect((await patch(owner.user.id, { role: "operations" })).status).toBe(200);
  });

  it("two owners demoting each other at the same moment cannot leave the system without an owner", async () => {
    const other = await createTestAdmin("owner");
    for (let round = 0; round < 8; round++) {
      await db.adminUser.updateMany({ data: { role: "owner", active: true } });
      // fresh sessions each round: a successful demotion ends the target's sessions
      const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await createSession({ userId })}`;
      const [ownerCookie, otherCookie] = [await cookieFor(owner.user.id), await cookieFor(other.user.id)];
      const results = await Promise.all([
        usersPatch(mk(`/api/admin/users/${other.user.id}`, "PATCH", ownerCookie, { role: "viewer" }), ctx(other.user.id)),
        usersPatch(mk(`/api/admin/users/${owner.user.id}`, "PATCH", otherCookie, { role: "viewer" }), ctx(owner.user.id)),
      ]);
      const statuses = results.map((r) => r.status).sort();
      // exactly one demotion wins; the loser is refused (409 last owner) or already signed out (401): never both succeed
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      expect(await db.adminUser.count({ where: { role: "owner", active: true } })).toBe(1);
    }
  });
});

describe("owner bootstrap and recovery script", () => {
  const run = (args: string[], password?: string) =>
    spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/admin-bootstrap.ts", ...args], {
      env: { ...process.env, ...(password ? { ADMIN_BOOTSTRAP_PASSWORD: password } : { ADMIN_BOOTSTRAP_PASSWORD: "" }) },
      encoding: "utf8",
      timeout: 90_000,
    });

  it("creates the first owner only, never prints the password, then refuses a second", async () => {
    await db.adminUser.deleteMany({});
    const email = `boot-${Date.now()}@${FIXTURE_EMAIL_DOMAIN}`;
    const PASSWORD = "bootstrap-secret-passphrase-77";
    const weak = run(["--email", email, "--name", "First Owner"], "short");
    expect(weak.status).toBe(1);
    expect(await db.adminUser.count()).toBe(0);
    const ok = run(["--email", email, "--name", "First Owner"], PASSWORD);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).not.toContain(PASSWORD);
    const u = await db.adminUser.findUniqueOrThrow({ where: { email } });
    expect(u).toMatchObject({ role: "owner", active: true, name: "First Owner" });
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email, password: PASSWORD }))).status).toBe(200);
    const again = run(["--email", `other-${email}`, "--name", "Second"], PASSWORD);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/owner already exists/);
    expect(await db.adminUser.count()).toBe(1);
    expect((await audit("owner.bootstrap")).length).toBe(1);
  }, 120_000);

  it("--reset recovers an owner: new password, sessions ended, lock and deactivation cleared", async () => {
    const o = await createTestAdmin("owner");
    await db.adminUser.update({ where: { id: o.user.id }, data: { active: false, failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    const NEW = "recovered-owner-passphrase-88";
    const r = run(["--reset", "--email", o.email], NEW);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(NEW);
    expect((await me(mk("/api/admin/me", "GET", o.cookie))).status).toBe(401);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: o.email, password: o.password }))).status).toBe(401);
    expect((await login(mk("/api/admin/login", "POST", undefined, { email: o.email, password: NEW }))).status).toBe(200);
    expect((await audit("owner.password_reset")).length).toBe(1);
    const notOwner = await createTestAdmin("viewer");
    expect(run(["--reset", "--email", notOwner.email], NEW).status).toBe(1); // only owners can be recovered this way
    expect(run(["--reset", "--email", `ghost@${FIXTURE_EMAIL_DOMAIN}`], NEW).status).toBe(1);
  }, 120_000);

  it("--additional-owner adds an owner next to an existing one, but only when the database is declared disposable", async () => {
    await createTestAdmin("owner");
    const email = `extra-${Date.now()}@${FIXTURE_EMAIL_DOMAIN}`;
    const PASSWORD = "additional-owner-passphrase-5";
    const refused = spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/admin-bootstrap.ts", "--email", email, "--name", "Extra", "--additional-owner"], { env: { ...process.env, TEST_TARGET: "", ADMIN_BOOTSTRAP_PASSWORD: PASSWORD }, encoding: "utf8", timeout: 90_000 });
    expect(refused.status).toBe(1);
    expect(await db.adminUser.count({ where: { email } })).toBe(0);
    const plain = run(["--email", email, "--name", "Extra"], PASSWORD); // without the flag an existing owner blocks creation
    expect(plain.status).toBe(1);
    const ok = run(["--email", email, "--name", "Extra", "--additional-owner"], PASSWORD);
    expect(ok.status, ok.stderr).toBe(0);
    expect(await db.adminUser.findUniqueOrThrow({ where: { email } })).toMatchObject({ role: "owner" });
  }, 180_000);

  it("requires an email, and a password source", () => {
    expect(run(["--name", "x"], "whatever-long-password-1").status).toBe(1);
    expect(run(["--email", `x@${FIXTURE_EMAIL_DOMAIN}`, "--name", "x"]).status).toBe(1); // no env password and no TTY
  }, 120_000);
});
