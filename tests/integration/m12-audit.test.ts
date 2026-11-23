/**
 * M12 independent audit (docs/M12-INDEPENDENT-AUDIT.md): one regression test per confirmed finding. Each test was run
 * against the pre-fix code and failed there; the finding id is in the describe title.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ERASED_EMAIL, eraseCustomer, exportCustomerData } from "@/lib/account/erasure";
import { issueOtp, verifyOtp } from "@/lib/auth/otp";
import { mockOtpOutbox } from "@/lib/auth/otp-sender";
import { verifyPassword } from "@/lib/auth/password";
import { placeWholesaleOrder } from "@/lib/wholesale/orders";
import { OrderError } from "@/lib/orders";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail, signInCustomer } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupWholesaleFixtures, makeBuyer, SHIPPING } from "../support/wholesale";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as claimRoute } from "@/app/api/account/claim/route";
import { POST as bizOrder } from "@/app/api/business/orders/route";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { POST as taxRateRoute } from "@/app/api/admin/tax-rates/route";
import { POST as shippingRuleCreate } from "@/app/api/admin/shipping-rules/route";
import { PATCH as shippingRulePatch, DELETE as shippingRuleDelete } from "@/app/api/admin/shipping-rules/[id]/route";
import { POST as priceListCreate } from "@/app/api/admin/price-lists/route";
import { PATCH as priceListPatch, DELETE as priceListDelete } from "@/app/api/admin/price-lists/[id]/route";
import { PUT as priceListItems } from "@/app/api/admin/price-lists/[id]/items/route";
import { PATCH as accountPatch } from "@/app/api/admin/wholesale/accounts/[id]/route";
import { PATCH as variantPatch } from "@/app/api/admin/variants/[id]/route";
import { PUT as variantWholesale } from "@/app/api/admin/variants/[id]/wholesale/route";

const tag = Date.now().toString(36);
let seq = 0;
const mk = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const retailBody = (variantId: string, over: Record<string, unknown> = {}) => ({
  customerName: "SMOKE TEST Stock", email: freshEmail("m12"), phone: "9876543210", addressLine1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001",
  paymentMethod: "cod", items: [{ variantId, quantity: 1 }], ...over,
});

/** Makes every AuditLog insert for `action` fail while `fn` runs (disposable DB only; always removed). */
async function withFailingAudit<T>(action: string, fn: () => Promise<T>): Promise<T> {
  const name = `vv_m12_audit_fail_${tag}_${++seq}`;
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."action" = '${action}') EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}
/** A route that throws (the in-transaction audit insert failed) is as good as a 500 for these tests. */
const statusOf = async (p: Promise<Response>) => p.then((r) => r.status, () => 500);

let variantId: string;
beforeEach(async () => {
  customerTestEnv();
  vi.stubEnv("PAYMENT_MODE", "request_only");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.spyOn(console, "error").mockImplementation(() => {});
  rate.rateLimit.mockResolvedValue(true);
  variantId ??= (await createInventoryVariant({ tracked: false })).variantId;
});
afterAll(async () => {
  await db.taxRate.deleteMany({ where: { note: { startsWith: "m12-" } } });
  await db.shippingRule.deleteMany({ where: { name: { startsWith: "m12-" } } });
  await db.priceList.deleteMany({ where: { name: { startsWith: "m12-" } } });
  await cleanupWholesaleFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("VA-01 export and erasure stay inside the requester's own account", () => {
  /** B places a signed-in order using A's address as the contact email (the form allows any address). */
  async function setup() {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const r = await read(await createOrderRoute(mk("/api/orders", "POST", b.cookie, retailBody(variantId, { email: a.email, customerName: "Bea Other", addressLine1: "99 Private Lane" }))));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await db.order.update({ where: { number: r.body.order.number }, data: { status: "delivered" } });
    return { a, b, number: r.body.order.number as string };
  }

  it("A's export does not contain an order that belongs to B's account", async () => {
    const { a, number } = await setup();
    const data = await exportCustomerData(a.customerId);
    expect(data!.orders.map((o) => o.number)).not.toContain(number);
  });

  it("A's erasure neither anonymises nor unlinks B's order", async () => {
    const { a, b, number } = await setup();
    const r = await eraseCustomer(a.customerId);
    expect(r.ok).toBe(true);
    const o = await db.order.findUniqueOrThrow({ where: { number } });
    expect(o).toMatchObject({ customerId: b.customerId, customerName: "Bea Other", addressLine1: "99 Private Lane" });
    expect(o.email).not.toBe(ERASED_EMAIL);
  });

  it("an open order of B's under A's email does not block A's erasure", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const r = await read(await createOrderRoute(mk("/api/orders", "POST", b.cookie, retailBody(variantId, { email: a.email }))));
    expect(r.status).toBe(201); // pending_confirmation = open
    expect(await eraseCustomer(a.customerId)).toMatchObject({ ok: true });
  });

  it("a guest order claimed by token by B is no longer A's to export or erase", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const g = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { email: a.email }))));
    const c = await read(await claimRoute(mk("/api/account/claim", "POST", b.cookie, { orderNumber: g.body.order.number, token: g.body.order.token })));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await exportCustomerData(a.customerId))!.orders.map((o) => o.number)).not.toContain(g.body.order.number);
  });

  it("A's own and unclaimed guest orders under A's email are still exported and anonymised", async () => {
    const a = await signInCustomer();
    const own = await read(await createOrderRoute(mk("/api/orders", "POST", a.cookie, retailBody(variantId, { email: a.email }))));
    const guest = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { email: a.email.toUpperCase() }))));
    const numbers = (await exportCustomerData(a.customerId))!.orders.map((o) => o.number);
    expect(numbers).toEqual(expect.arrayContaining([own.body.order.number, guest.body.order.number]));
    await db.order.updateMany({ where: { number: { in: [own.body.order.number, guest.body.order.number] } }, data: { status: "delivered" } });
    expect(await eraseCustomer(a.customerId)).toMatchObject({ ok: true, ordersAnonymised: 2 });
  });
});

describe("VA-02 checkout never silently changes the quantity", () => {
  it("duplicate lines that add up to more than the per-line limit are refused, not truncated", async () => {
    const r = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { items: [{ variantId, quantity: 30 }, { variantId, quantity: 30 }] }))));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/50/);
  });

  it("duplicate lines within the limit are merged exactly", async () => {
    const r = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { items: [{ variantId, quantity: 20 }, { variantId, quantity: 30 }] }))));
    expect(r.status).toBe(201);
    expect(await db.orderItem.findMany({ where: { order: { number: r.body.order.number } }, select: { quantity: true } })).toEqual([{ quantity: 50 }]);
  });
});

describe("VA-03 wholesale orders re-check the account inside the order transaction", () => {
  it("an account suspended after the request was authorised cannot place the order", async () => {
    const b = await makeBuyer();
    const snapshot = b.account; // what requireBusiness loaded (approved)
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "suspended" } });
    await expect(placeWholesaleOrder(snapshot, b.customerId, { ...SHIPPING, items: [{ variantId, quantity: 1 }] })).rejects.toBeInstanceOf(OrderError);
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
  });

  it("a credit limit lowered after authorisation is the one enforced", async () => {
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 10_000_000 });
    const snapshot = b.account;
    await db.businessAccount.update({ where: { id: b.account.id }, data: { creditLimit: 1_000 } });
    await expect(placeWholesaleOrder(snapshot, b.customerId, { ...SHIPPING, items: [{ variantId, quantity: 1 }] })).rejects.toMatchObject({ status: 409 });
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
  });

  it("terms switched from prepaid to credit after authorisation are enforced", async () => {
    const b = await makeBuyer({ paymentTerms: "prepaid" });
    const snapshot = b.account;
    await db.businessAccount.update({ where: { id: b.account.id }, data: { paymentTerms: "credit", creditLimit: 1_000 } });
    await expect(placeWholesaleOrder(snapshot, b.customerId, { ...SHIPPING, items: [{ variantId, quantity: 1 }] })).rejects.toMatchObject({ status: 409 });
  });

  it("parallel credit orders still cannot jointly exceed the limit", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10_000 });
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 10_000_000 });
    const first = await read(await bizOrder(mk("/api/business/orders", "POST", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 1 }] })));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const perOrder = (await db.order.findFirstOrThrow({ where: { number: first.body.order.number } })).total;
    await db.businessAccount.update({ where: { id: b.account.id }, data: { creditLimit: perOrder * 3 } }); // one used, room for exactly two more
    const results = await Promise.all(Array.from({ length: 6 }, () => bizOrder(mk("/api/business/orders", "POST", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 1 }] })).then((r) => r.status)));
    expect(results.filter((s) => s === 201)).toHaveLength(2);
    expect(results.filter((s) => s === 409)).toHaveLength(4);
  });
});

describe("M12-A01 order totals beyond the database integer range are refused cleanly", () => {
  it("a bulk wholesale order whose total exceeds the money column range is a 422, not a 500", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 5_000_000 }); // ₹50,000
    await db.variant.update({ where: { id: v.variantId }, data: { mrp: 6_000_000 } });
    const b = await makeBuyer();
    const r = await read(await bizOrder(mk("/api/business/orders", "POST", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 1_000 }] }))); // 5e9 paise
    expect(r.status).toBe(422);
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
  });
});

describe("VA-04 an admin account change applies completely or not at all", () => {
  it("a role change with a weak password is rejected without changing the role", async () => {
    const owner = await createTestAdmin("owner");
    const target = await createTestAdmin("operations");
    const r = await read(await patchUser(mk(`/api/admin/users/${target.user.id}`, "PATCH", owner.cookie, { role: "viewer", password: "short" }), ctx(target.user.id)));
    expect(r.status).toBe(422);
    const u = await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(u.role).toBe("operations");
    expect(await db.adminSession.count({ where: { userId: target.user.id, revokedAt: null } })).toBe(1); // nothing revoked either
  });

  it("deactivation with a weak password changes nothing", async () => {
    const owner = await createTestAdmin("owner");
    const target = await createTestAdmin("catalog");
    const r = await patchUser(mk(`/api/admin/users/${target.user.id}`, "PATCH", owner.cookie, { active: false, password: "x" }), ctx(target.user.id));
    expect(r.status).toBe(422);
    expect((await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } })).active).toBe(true);
  });

  it("role and password change together: both apply, one audit-consistent transaction", async () => {
    const owner = await createTestAdmin("owner");
    const target = await createTestAdmin("operations");
    const pw = "a much better passphrase 2026";
    const r = await read(await patchUser(mk(`/api/admin/users/${target.user.id}`, "PATCH", owner.cookie, { role: "viewer", password: pw }), ctx(target.user.id)));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(u.role).toBe("viewer");
    expect(await verifyPassword(pw, u.passwordHash)).toBe(true);
  });

  it("if the password-reset audit cannot be written, the role change rolls back too", async () => {
    const owner = await createTestAdmin("owner");
    const target = await createTestAdmin("operations");
    const status = await withFailingAudit("user.password_reset", () => statusOf(patchUser(mk(`/api/admin/users/${target.user.id}`, "PATCH", owner.cookie, { role: "viewer", password: "a much better passphrase 2026" }), ctx(target.user.id))));
    expect(status).toBeGreaterThanOrEqual(500);
    expect((await db.adminUser.findUniqueOrThrow({ where: { id: target.user.id } })).role).toBe("operations");
  });
});

describe("VA-05 financial configuration changes commit only with their audit row", () => {
  let owner: Awaited<ReturnType<typeof createTestAdmin>>;
  beforeEach(async () => {
    owner ??= await createTestAdmin("owner");
  });

  it("GST rate", async () => {
    const note = `m12-${tag}-${++seq}`;
    const status = await withFailingAudit("tax_rate.create", () => statusOf(taxRateRoute(mk("/api/admin/tax-rates", "POST", owner.cookie, { code: "0909", rateBp: 500, effectiveFrom: "2098-01-01", note }))));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(await db.taxRate.count({ where: { note } })).toBe(0);
    const ok = await taxRateRoute(mk("/api/admin/tax-rates", "POST", owner.cookie, { code: "0909", rateBp: 500, effectiveFrom: "2098-01-01", note }));
    expect(ok.status).toBe(201);
    expect(await db.auditLog.count({ where: { action: "tax_rate.create", outcome: "success", actorUserId: owner.user.id } })).toBeGreaterThan(0);
  });

  it("shipping rules: create, update, delete", async () => {
    const name = `m12-${tag}-${++seq}`;
    const body = { name, pincodePrefix: "99", serviceable: true, fee: 7_000, active: false };
    expect(await withFailingAudit("shipping_rule.create", () => statusOf(shippingRuleCreate(mk("/api/admin/shipping-rules", "POST", owner.cookie, body))))).toBeGreaterThanOrEqual(500);
    expect(await db.shippingRule.count({ where: { name } })).toBe(0);
    const created = await read(await shippingRuleCreate(mk("/api/admin/shipping-rules", "POST", owner.cookie, body)));
    expect(created.status).toBe(201);
    const id = created.body.rule.id as string;
    expect(await withFailingAudit("shipping_rule.update", () => statusOf(shippingRulePatch(mk(`/api/admin/shipping-rules/${id}`, "PATCH", owner.cookie, { fee: 1 }), ctx(id))))).toBeGreaterThanOrEqual(500);
    expect((await db.shippingRule.findUniqueOrThrow({ where: { id } })).fee).toBe(7_000);
    expect(await withFailingAudit("shipping_rule.delete", () => statusOf(shippingRuleDelete(mk(`/api/admin/shipping-rules/${id}`, "DELETE", owner.cookie), ctx(id))))).toBeGreaterThanOrEqual(500);
    expect(await db.shippingRule.count({ where: { id } })).toBe(1);
  });

  it("price lists: create, update, tiers, delete", async () => {
    const name = `m12-${tag}-${++seq}`;
    expect(await withFailingAudit("price_list.create", () => statusOf(priceListCreate(mk("/api/admin/price-lists", "POST", owner.cookie, { name }))))).toBeGreaterThanOrEqual(500);
    expect(await db.priceList.count({ where: { name } })).toBe(0);
    const list = await read(await priceListCreate(mk("/api/admin/price-lists", "POST", owner.cookie, { name })));
    const id = list.body.priceList.id as string;
    expect(await withFailingAudit("price_list.update", () => statusOf(priceListPatch(mk(`/api/admin/price-lists/${id}`, "PATCH", owner.cookie, { active: false }), ctx(id))))).toBeGreaterThanOrEqual(500);
    expect((await db.priceList.findUniqueOrThrow({ where: { id } })).active).toBe(true);
    expect(await withFailingAudit("price_list.items", () => statusOf(priceListItems(mk(`/api/admin/price-lists/${id}/items`, "PUT", owner.cookie, { variantId, tiers: [{ minQty: 1, unitPrice: 30_000 }] }), ctx(id))))).toBeGreaterThanOrEqual(500);
    expect(await db.priceListItem.count({ where: { priceListId: id } })).toBe(0);
    expect(await withFailingAudit("price_list.delete", () => statusOf(priceListDelete(mk(`/api/admin/price-lists/${id}`, "DELETE", owner.cookie), ctx(id))))).toBeGreaterThanOrEqual(500);
    expect(await db.priceList.count({ where: { id } })).toBe(1);
  });

  it("business account terms and credit limit", async () => {
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 100_000 });
    expect(await withFailingAudit("business_account.update", () => statusOf(accountPatch(mk(`/api/admin/wholesale/accounts/${b.account.id}`, "PATCH", owner.cookie, { creditLimit: 9_000_000 }), ctx(b.account.id))))).toBeGreaterThanOrEqual(500);
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: b.account.id } })).creditLimit).toBe(100_000);
  });

  it("retail price and wholesale MOQ of a variant", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 40_000 });
    expect(await withFailingAudit("variant.price", () => statusOf(variantPatch(mk(`/api/admin/variants/${v.variantId}`, "PATCH", owner.cookie, { price: 1 }), ctx(v.variantId))))).toBeGreaterThanOrEqual(500);
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.variantId } })).price).toBe(40_000);
    expect(await withFailingAudit("variant.wholesale", () => statusOf(variantWholesale(mk(`/api/admin/variants/${v.variantId}/wholesale`, "PUT", owner.cookie, { moq: 12, casePack: 6 }), ctx(v.variantId))))).toBeGreaterThanOrEqual(500);
    expect(await db.variantWholesale.count({ where: { variantId: v.variantId } })).toBe(0);
    // and the normal path records the old and new price
    const ok = await variantPatch(mk(`/api/admin/variants/${v.variantId}`, "PATCH", owner.cookie, { price: 450 }), ctx(v.variantId));
    expect(ok.status).toBe(200);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "variant.price", targetId: v.variantId, outcome: "success" } });
    expect(JSON.parse(row.details!)).toMatchObject({ from: 40_000, to: 45_000 });
  });

  it("a stock adjustment sent with a price change rolls back when the price audit fails (no double-apply on retry)", async () => {
    const v = await createInventoryVariant({ tracked: true, stock: 10, price: 40_000 });
    const body = { price: 450, stockAdjust: { delta: 5, reason: "m12 combined" } };
    expect(await withFailingAudit("variant.price", () => statusOf(variantPatch(mk(`/api/admin/variants/${v.variantId}`, "PATCH", owner.cookie, body), ctx(v.variantId))))).toBeGreaterThanOrEqual(500);
    expect(await db.variant.findUniqueOrThrow({ where: { id: v.variantId }, select: { price: true, stockQuantity: true } })).toEqual({ price: 40_000, stockQuantity: 10 });
    const ok = await read(await variantPatch(mk(`/api/admin/variants/${v.variantId}`, "PATCH", owner.cookie, body), ctx(v.variantId)));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ price: 45_000, stockQuantity: 15, trackInventory: true });
  });
});

describe("VA-06 sign-in codes: parallel requests cannot multiply live codes or emails", () => {
  it("ten simultaneous requests for one address issue exactly one code", async () => {
    const email = freshEmail("otp-race");
    const before = mockOtpOutbox.length;
    const results = await Promise.all(Array.from({ length: 10 }, () => issueOtp(email)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(mockOtpOutbox.length - before).toBe(1);
    const live = await db.otpChallenge.count({ where: { consumedAt: null, expiresAt: { gt: new Date() } } });
    expect(live).toBe(1);
  });

  it("the hourly cap holds under parallel requests spread past the cooldown", async () => {
    const email = freshEmail("otp-cap");
    const base = Date.now() + 3_600_000; // a clean hour in the future, so earlier rows do not count
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => issueOtp(email, new Date(base + (i % 10) * 31_000))));
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(5);
  });

  it("a code still signs the customer in after the change", async () => {
    const email = freshEmail("otp-ok");
    expect(await issueOtp(email)).toEqual({ ok: true });
    const code = [...mockOtpOutbox].reverse().find((o) => o.email === email)!.code;
    expect(await verifyOtp({ email, code, acceptTerms: true })).toMatchObject({ ok: true, created: true });
  });
});

describe("M12 admin reporting: sales summary", () => {
  it("counts real orders by Indian day, separates collected money, and leaves out cancelled and test orders", async () => {
    const { salesSummary, istDayStart, istMonthStart } = await import("@/lib/ops/sales-report");
    // 2026-11-22 23:00 IST is 17:30 UTC the same day; 00:30 IST on the 23rd is 19:00 UTC on the 22nd
    expect(istDayStart(new Date("2026-11-22T17:30:00Z")).toISOString()).toBe("2026-11-21T18:30:00.000Z");
    expect(istDayStart(new Date("2026-11-22T19:00:00Z")).toISOString()).toBe("2026-11-22T18:30:00.000Z");
    expect(istMonthStart(new Date("2026-11-30T19:00:00Z")).toISOString()).toBe("2026-11-30T18:30:00.000Z"); // already 1 Dec in India
    const before = await salesSummary();
    const real = { customerName: "Sales Fixture", email: freshEmail("sales") };
    const a = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { ...real, items: [{ variantId, quantity: 2 }] }))));
    const b = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { ...real, email: freshEmail("sales") }))));
    const c = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId, { ...real, email: freshEmail("sales") }))));
    await read(await createOrderRoute(mk("/api/orders", "POST", undefined, retailBody(variantId)))); // SMOKE TEST: never counted
    await db.order.update({ where: { number: b.body.order.number }, data: { paymentStatus: "paid", status: "paid" } });
    await db.order.update({ where: { number: c.body.order.number }, data: { status: "cancelled" } });
    const after = await salesSummary();
    const d = (k: string) => {
      const x = after.periods.find((p) => p.key === k)!;
      const y = before.periods.find((p) => p.key === k)!;
      return { orders: x.orders - y.orders, value: x.value - y.value, collected: x.collected - y.collected, cancelled: x.cancelled - y.cancelled };
    };
    for (const k of ["today", "last7", "month"]) expect(d(k)).toEqual({ orders: 2, value: a.body.order.total + b.body.order.total, collected: b.body.order.total, cancelled: 1 });
    await db.order.deleteMany({ where: { customerName: "Sales Fixture" } });
  });
});
