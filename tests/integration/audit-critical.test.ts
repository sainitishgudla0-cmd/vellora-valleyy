/**
 * M11 P1-T4 (F07): a critical change (money, payment state, accounts, roles, credentials) commits only together with its
 * audit row. An audit insert that fails (injected with a temporary Postgres trigger on the disposable DB) rolls the
 * change back; best-effort audits (rejections, non-critical edits) still never fail the request.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/auth/audit";
import { verifyPassword } from "@/lib/auth/password";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET, TEST_WEBHOOK_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createFixtureOrder, createRazorpayOrderWithAttempt } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { PATCH as patchOrder } from "@/app/api/admin/orders/[id]/route";
import { POST as refundRoute } from "@/app/api/admin/orders/[id]/refunds/route";
import { POST as createUserRoute } from "@/app/api/admin/users/route";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { POST as changePassword } from "@/app/api/admin/account/password/route";

let owner: Awaited<ReturnType<typeof createTestAdmin>>;
let fake: FakeRazorpay;
const tag = Date.now().toString(36);
let seq = 0;

const req = (url: string, method: string, cookie: string, body: unknown) => new Request(`http://localhost${url}`, { method, headers: { cookie }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function codOrder() {
  const order = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "confirmed", paymentStatus: "unpaid" });
  await db.payment.create({ data: { orderId: order.id, provider: "request_only", mode: "request_only", amount: order.total, currency: "INR", status: "unpaid" } });
  return order;
}
const auditRows = (action: string, targetId?: string) => db.auditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });

/** Makes every AuditLog insert for `action` fail while `fn` runs (disposable DB only; always removed). */
async function withFailingAudit<T>(action: string, fn: () => Promise<T>): Promise<T> {
  const name = `vv_audit_fail_${tag}_${++seq}`;
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."action" = '${action}') EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("LOG_LEVEL", "error");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeRazorpay().install();
  owner ??= await createTestAdmin("owner");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("payments and orders fail closed without their audit row", () => {
  it("manual payment confirmation: audit failure leaves order, payment and history untouched; the retry succeeds with exactly one audit row", async () => {
    const order = await codOrder();
    const body = { paymentStatus: "paid", reason: "Cash collected", paymentReference: `RCPT-AUD-${tag}` };
    await withFailingAudit("order.update", () => expect(patchOrder(req("/api/admin/orders/x", "PATCH", owner.cookie, body), ctx(order.id))).rejects.toThrow());
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true, events: true } });
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.payments[0]).toMatchObject({ status: "unpaid", manualReference: null });
    expect(after.events).toHaveLength(0);
    expect(await auditRows("order.update", order.id)).toHaveLength(0);

    expect((await patchOrder(req("/api/admin/orders/x", "PATCH", owner.cookie, body), ctx(order.id))).status).toBe(200);
    const rows = await auditRows("order.update", order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", actorUserId: owner.user.id, actorLabel: owner.email });
    expect(JSON.parse(rows[0].details!)).toMatchObject({ paymentStatus: "paid", changed: true });
  });

  it("a plain status change is also rolled back when its audit cannot be written", async () => {
    const order = await codOrder();
    await withFailingAudit("order.update", () => expect(patchOrder(req("/api/admin/orders/x", "PATCH", owner.cookie, { status: "dispatched" }), ctx(order.id))).rejects.toThrow());
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("confirmed");
  });

  it("refund request: audit failure means no ledger row and no gateway call; the retry refunds once", async () => {
    const total = 52000;
    const f = await createRazorpayOrderWithAttempt({ status: "paid", paymentStatus: "paid", total });
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: total });
    await db.payment.update({ where: { id: f.attempt.id }, data: { status: "paid", providerPaymentId: pay.id } });
    const body = { reason: "Customer returned the goods", requestKey: `aud-${tag}-${++seq}` };
    await withFailingAudit("order.refund.requested", () => expect(refundRoute(req("/api/admin/orders/x/refunds", "POST", owner.cookie, body), ctx(f.order.id))).rejects.toThrow());
    expect(await db.refund.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(fake.calls.filter((c) => c.endsWith("/refund"))).toHaveLength(0);

    const ok = await refundRoute(req("/api/admin/orders/x/refunds", "POST", owner.cookie, body), ctx(f.order.id));
    expect(ok.status).toBe(201);
    const refunds = await db.refund.findMany({ where: { orderId: f.order.id } });
    expect(refunds).toHaveLength(1);
    const requested = await auditRows("order.refund.requested", f.order.id);
    expect(requested).toHaveLength(1);
    expect(JSON.parse(requested[0].details!)).toMatchObject({ refundId: refunds[0].id, amountPaise: total });
    expect(fake.calls.filter((c) => c.endsWith("/refund"))).toHaveLength(1);
  });
});

describe("accounts, roles and credentials fail closed without their audit row", () => {
  it("creating an account", async () => {
    const email = `aud-new-${tag}@example.test`;
    const body = { email, name: "Audit Probe", role: "viewer", password: "a perfectly fine passphrase 42" };
    await withFailingAudit("user.create", () => expect(createUserRoute(req("/api/admin/users", "POST", owner.cookie, body))).rejects.toThrow());
    expect(await db.adminUser.count({ where: { email } })).toBe(0);
    expect((await createUserRoute(req("/api/admin/users", "POST", owner.cookie, body))).status).toBe(201);
    expect(await db.adminUser.count({ where: { email } })).toBe(1);
  });

  it("changing a role keeps the old role and the user's sessions", async () => {
    const target = await createTestAdmin("viewer");
    await withFailingAudit("user.update", () => expect(patchUser(req("/api/admin/users/x", "PATCH", owner.cookie, { role: "operations" }), ctx(target.user.id))).rejects.toThrow());
    expect((await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } })).role).toBe("viewer");
    expect(await db.adminSession.count({ where: { userId: target.user.id, revokedAt: null } })).toBe(1);
    expect((await patchUser(req("/api/admin/users/x", "PATCH", owner.cookie, { role: "operations" }), ctx(target.user.id))).status).toBe(200);
    const rows = await auditRows("user.update", target.user.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details!)).toMatchObject({ fields: ["role"], role: "operations", sessionsRevoked: 1 });
  });

  it("an owner's password reset of another account keeps the old password", async () => {
    const target = await createTestAdmin("viewer");
    await withFailingAudit("user.password_reset", () => expect(patchUser(req("/api/admin/users/x", "PATCH", owner.cookie, { password: "reset passphrase for audit 9" }), ctx(target.user.id))).rejects.toThrow());
    const u = await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(await verifyPassword(target.password, u.passwordHash)).toBe(true);
    expect(await db.adminSession.count({ where: { userId: target.user.id, revokedAt: null } })).toBe(1);
  });

  it("changing your own password keeps the old one", async () => {
    const me = await createTestAdmin("operations");
    const body = { currentPassword: me.password, newPassword: "my new audited passphrase 5" };
    await withFailingAudit("password.change", () => expect(changePassword(req("/api/admin/account/password", "POST", me.cookie, body))).rejects.toThrow());
    expect(await verifyPassword(me.password, (await db.adminUser.findUniqueOrThrow({ where: { id: me.user.id } })).passwordHash)).toBe(true);
    expect((await changePassword(req("/api/admin/account/password", "POST", me.cookie, body))).status).toBe(200);
    expect(await auditRows("password.change", me.user.id)).toHaveLength(1);
  });
});

describe("best-effort audits stay best-effort", () => {
  it("writeAudit swallows a failed insert (non-critical actions never turn into errors)", async () => {
    await withFailingAudit("enquiry.update", () => expect(writeAudit({ action: "enquiry.update", outcome: "success" })).resolves.toBeUndefined());
  });

  it("a rejected critical request still answers normally when its (best-effort) rejection audit fails", async () => {
    const target = await createTestAdmin("viewer");
    await withFailingAudit("user.update", async () => {
      const res = await patchUser(req("/api/admin/users/x", "PATCH", owner.cookie, { password: "short" }), ctx(target.user.id));
      expect(res.status).toBe(422);
    });
  });
});
