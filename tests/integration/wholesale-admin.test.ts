/** M6-T5/T6: admin side: role × route matrix, approval workflow, enquiry conversion, price lists, MOQ, erasure interplay. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail, signInCustomer } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupWholesaleFixtures, createPriceList, makeBuyer, makeGstin } from "../support/wholesale";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { GET as accountsList } from "@/app/api/admin/wholesale/accounts/route";
import { GET as accountGet, PATCH as accountPatch } from "@/app/api/admin/wholesale/accounts/[id]/route";
import { POST as convert } from "@/app/api/admin/enquiries/[id]/convert/route";
import { GET as listsGet, POST as listsPost } from "@/app/api/admin/price-lists/route";
import { GET as listGet, PATCH as listPatch, DELETE as listDelete } from "@/app/api/admin/price-lists/[id]/route";
import { PUT as itemsPut } from "@/app/api/admin/price-lists/[id]/items/route";
import { PUT as termsPut } from "@/app/api/admin/variants/[id]/wholesale/route";
import { GET as quotesGet } from "@/app/api/admin/quotes/route";
import { PATCH as quotePatch } from "@/app/api/admin/quotes/[id]/route";
import { GET as priceListGet } from "@/app/api/business/price-list/route";
import { DELETE as deleteAccount } from "@/app/api/account/route";
import { GET as exportData } from "@/app/api/account/export/route";

const mk = (url: string, method: string, cookie?: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const audit = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

let owner: Awaited<ReturnType<typeof createTestAdmin>>;
beforeEach(async () => {
  customerTestEnv();
  rate.rateLimit.mockResolvedValue(true);
  owner ??= await createTestAdmin("owner");
  await db.auditLog.deleteMany({});
});
afterAll(async () => {
  await cleanupWholesaleFixtures();
  await db.enquiry.deleteMany({ where: { email: { endsWith: "@m6-fixture.example.com" } } });
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("role × route matrix", () => {
  const ROLES: AdminRole[] = ["owner", "operations", "catalog", "viewer"];
  const READ: AdminRole[] = ["owner", "operations", "catalog"];
  const ROUTES: [string, AdminRole[], (c?: string) => Promise<Response>][] = [
    ["GET accounts", READ, (c) => accountsList(mk("/api/admin/wholesale/accounts", "GET", c))],
    ["GET accounts/[id]", READ, (c) => accountGet(mk("/api/admin/wholesale/accounts/x", "GET", c), ctx({ id: "x" }))],
    ["PATCH accounts/[id]", ["owner", "operations"], (c) => accountPatch(mk("/api/admin/wholesale/accounts/x", "PATCH", c, { adminNote: "n" }), ctx({ id: "x" }))],
    ["POST enquiries/[id]/convert", ["owner", "operations"], (c) => convert(mk("/api/admin/enquiries/x/convert", "POST", c, { companyName: "X Foods", gstin: "27AAPFU0939F1ZV" }), ctx({ id: "x" }))],
    ["GET price-lists", READ, (c) => listsGet(mk("/api/admin/price-lists", "GET", c))],
    ["POST price-lists", ["owner", "catalog"], (c) => listsPost(mk("/api/admin/price-lists", "POST", c, { name: `m6-matrix-${Math.random()}` }))],
    ["GET price-lists/[id]", READ, (c) => listGet(mk("/api/admin/price-lists/x", "GET", c), ctx({ id: "x" }))],
    ["PATCH price-lists/[id]", ["owner", "catalog"], (c) => listPatch(mk("/api/admin/price-lists/x", "PATCH", c, { active: true }), ctx({ id: "x" }))],
    ["DELETE price-lists/[id]", ["owner", "catalog"], (c) => listDelete(mk("/api/admin/price-lists/x", "DELETE", c), ctx({ id: "x" }))],
    ["PUT price-lists/[id]/items", ["owner", "catalog"], (c) => itemsPut(mk("/api/admin/price-lists/x/items", "PUT", c, { variantId: "v", tiers: [] }), ctx({ id: "x" }))],
    ["PUT variants/[id]/wholesale", ["owner", "catalog"], (c) => termsPut(mk("/api/admin/variants/x/wholesale", "PUT", c, { moq: 1, casePack: 1 }), ctx({ id: "x" }))],
    ["GET quotes", READ, (c) => quotesGet(mk("/api/admin/quotes", "GET", c))],
    ["PATCH quotes/[id]", ["owner", "operations"], (c) => quotePatch(mk("/api/admin/quotes/x", "PATCH", c, { action: "reject" }), ctx({ id: "x" }))],
  ];
  it.each(ROUTES)("%s", async (_n, allowed, call) => {
    expect((await call()).status).toBe(401);
    for (const role of ROLES) {
      const who = role === "owner" ? owner : await createTestAdmin(role);
      const status = (await call(who.cookie)).status;
      if (allowed.includes(role)) expect([401, 403], `${role} should be allowed`).not.toContain(status);
      else expect(status, `${role} should be refused`).toBe(403);
    }
  });

  it("a customer (even an approved buyer) is not an admin", async () => {
    const b = await makeBuyer();
    expect((await accountsList(mk("/api/admin/wholesale/accounts", "GET", b.cookie))).status).toBe(401);
  });
});

describe("account approval workflow", () => {
  const patch = (id: string, body: unknown, cookie = owner.cookie) => accountPatch(mk(`/api/admin/wholesale/accounts/${id}`, "PATCH", cookie, body), ctx({ id })).then(read);
  const pending = async () => (await makeBuyer({ status: "pending" })).account;

  it("pending → approved sets approvedAt, terms, price list; the buyer is active immediately", async () => {
    const b = await makeBuyer({ status: "pending" });
    const v = await createInventoryVariant({ tracked: false });
    const list = await createPriceList("approval", [{ variantId: v.variantId, tiers: [{ minQty: 1, unitPrice: 100 }] }]);
    expect((await priceListGet(mk("/api/business/price-list", "GET", b.cookie))).status).toBe(403);
    const r = await patch(b.account.id, { status: "approved", paymentTerms: "credit", creditLimit: 2_500_000, priceListId: list.id, adminNote: "Visited the shop" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, account: { status: "approved", paymentTerms: "credit", creditLimit: 2_500_000, priceListId: list.id, adminNote: "Visited the shop" } } });
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: b.account.id } })).approvedAt).not.toBeNull();
    expect((await priceListGet(mk("/api/business/price-list", "GET", b.cookie))).status).toBe(200);
    const row = (await audit("business_account.update"))[0];
    expect(row).toMatchObject({ outcome: "success", actorUserId: owner.user.id });
    expect(JSON.stringify(row)).not.toContain("Visited the shop"); // the internal note is not copied into the log
  });

  it.each([
    ["approved", "pending"], ["approved", "rejected"], ["pending", "suspended"], ["rejected", "suspended"], ["rejected", "pending"], ["closed", "approved"], ["closed", "pending"],
  ] as const)("%s → %s is refused (409) and changes nothing", async (from, to) => {
    const b = await makeBuyer({ status: from });
    const r = await patch(b.account.id, { status: to });
    expect(r).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: b.account.id } })).status).toBe(from);
  });

  it.each([["pending", "rejected"], ["pending", "closed"], ["approved", "suspended"], ["approved", "closed"], ["suspended", "approved"], ["suspended", "closed"], ["rejected", "approved"]] as const)("%s → %s is allowed", async (from, to) => {
    const b = await makeBuyer({ status: from });
    expect((await patch(b.account.id, { status: to })).status).toBe(200);
  });

  it("credit terms need a limit to approve; the price list must exist and be active; unknown fields and empty bodies are refused", async () => {
    const a = await pending();
    expect(await patch(a.id, { status: "approved", paymentTerms: "credit" })).toMatchObject({ status: 422 });
    expect((await patch(a.id, { status: "approved", paymentTerms: "credit", creditLimit: 1 })).status).toBe(200);
    const b = await pending();
    expect((await patch(b.id, { priceListId: "nope" })).status).toBe(422);
    const inactive = await createPriceList("off", [], false);
    expect((await patch(b.id, { priceListId: inactive.id })).status).toBe(422);
    expect((await patch(b.id, {})).status).toBe(422);
    expect((await patch(b.id, { customerId: "x" })).status).toBe(422);
    expect((await patch(b.id, { creditLimit: -1 })).status).toBe(422);
    expect((await patch(b.id, { creditLimit: 1.5 })).status).toBe(422);
    expect((await patch("none", { adminNote: "x" })).status).toBe(404);
  });

  it("racing approve against close always ends in a state consistent with who won (no lost or invented transitions)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const b = await makeBuyer({ status: "pending" });
      const [approve, close] = (await Promise.all([patch(b.account.id, { status: "approved" }), patch(b.account.id, { status: "closed" })])).map((r) => r.status);
      const final = (await db.businessAccount.findUniqueOrThrow({ where: { id: b.account.id } })).status;
      // approve then close -> closed; close first -> approve refused, closed; approve first, close read a stale state -> refused, approved
      const outcome = `${approve}/${close}/${final}`;
      seen.add(outcome);
      expect(["200/200/closed", "409/200/closed", "200/409/approved"], outcome).toContain(outcome);
    }
  });

  it("lists with a status filter and shows details without the buyer's private fields leaking the other way", async () => {
    const b = await makeBuyer({ status: "pending" });
    const list = await read(await accountsList(mk("/api/admin/wholesale/accounts?status=pending", "GET", owner.cookie)));
    expect(list.body.accounts.map((a: any) => a.id)).toContain(b.account.id);
    expect(list.body.accounts.every((a: any) => a.status === "pending")).toBe(true);
    expect((await accountsList(mk("/api/admin/wholesale/accounts?status=bogus", "GET", owner.cookie))).status).toBe(422);
    const one = await read(await accountGet(mk(`/api/admin/wholesale/accounts/${b.account.id}`, "GET", owner.cookie), ctx({ id: b.account.id })));
    expect(one.body).toMatchObject({ account: { companyName: "Rao Traders", linkedToCustomer: true }, orders: 0, quotes: 0 });
    expect((await accountGet(mk("/api/admin/wholesale/accounts/none", "GET", owner.cookie), ctx({ id: "none" }))).status).toBe(404);
  });
});

describe("enquiry → account", () => {
  const enquiry = (over: Record<string, unknown> = {}) => db.enquiry.create({ data: { type: "business", name: "Asha Rao", email: freshEmail("enq").replace("m5-fixture", "m6-fixture"), phone: "9876543210", interest: "retail", message: "We run 6 supermarkets and want to stock your dates.", ...over } });
  const conv = (id: string, body: unknown) => convert(mk(`/api/admin/enquiries/${id}/convert`, "POST", owner.cookie, body), ctx({ id })).then(read);
  const gst = () => makeGstin();

  it("creates a pending account from the enquiry, closes nothing prematurely, and links to the person when they sign in", async () => {
    const e = await enquiry();
    const r = await conv(e.id, { companyName: "Rao Supermarkets", gstin: gst() });
    expect(r).toMatchObject({ status: 201, body: { ok: true, status: "pending" } });
    const acc = await db.businessAccount.findUniqueOrThrow({ where: { id: r.body.accountId } });
    expect(acc).toMatchObject({ contactEmail: e.email, contactName: "Asha Rao", phone: "9876543210", interest: "retail", customerId: null, status: "pending" });
    expect((await db.enquiry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("in_progress");
    const person = await signInCustomer(e.email);
    await db.businessAccount.update({ where: { id: acc.id }, data: { status: "approved" } });
    expect((await priceListGet(mk("/api/business/price-list", "GET", person.cookie))).status).toBe(200);
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: acc.id } })).customerId).toBe(person.customerId);
    expect((await audit("enquiry.convert"))[0]).toMatchObject({ outcome: "success", targetId: e.id });
  });

  it("can approve at once with terms, linking an existing customer immediately, and closes the enquiry", async () => {
    const email = freshEmail("existing").replace("m5-fixture", "m6-fixture");
    const person = await signInCustomer(email);
    const e = await enquiry({ email });
    const list = await createPriceList("convert");
    const r = await conv(e.id, { companyName: "Rao Supermarkets", gstin: gst(), approve: true, priceListId: list.id, paymentTerms: "credit", creditLimit: 900_000 });
    expect(r.body.status).toBe("approved");
    const acc = await db.businessAccount.findUniqueOrThrow({ where: { id: r.body.accountId } });
    expect(acc).toMatchObject({ customerId: person.customerId, status: "approved", priceListId: list.id, paymentTerms: "credit", creditLimit: 900_000 });
    expect((await db.enquiry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("closed");
  });

  it("refuses: non-business enquiries, bad GSTIN, credit without a limit, a duplicate person, a duplicate GSTIN, unknown ids and unknown fields", async () => {
    const contact = await enquiry({ type: "contact", interest: null });
    expect(await conv(contact.id, { companyName: "X Foods", gstin: gst() })).toMatchObject({ status: 409, body: { code: "not_a_business_enquiry" } });
    const e = await enquiry();
    expect((await conv(e.id, { companyName: "X Foods", gstin: "27AAPFU0939F1ZW" })).status).toBe(422);
    expect((await conv(e.id, { companyName: "X Foods", gstin: gst(), approve: true, paymentTerms: "credit" })).status).toBe(422);
    expect((await conv(e.id, { companyName: "X Foods", gstin: gst(), isAdmin: true })).status).toBe(422);
    expect((await conv("none", { companyName: "X Foods", gstin: gst() })).status).toBe(404);
    expect((await conv(e.id, { companyName: "X Foods", gstin: gst() })).status).toBe(201);
    expect(await conv(e.id, { companyName: "X Foods", gstin: gst() })).toMatchObject({ status: 409, body: { code: "account_exists" } });
    const e2 = await enquiry();
    const taken = (await db.businessAccount.findFirstOrThrow({ where: { contactEmail: e.email } })).gstin;
    expect(await conv(e2.id, { companyName: "Y Foods", gstin: taken })).toMatchObject({ status: 409, body: { code: "gstin_in_use" } });
    expect(await db.businessAccount.count({ where: { contactEmail: e2.email } })).toBe(0); // the failed conversion rolled back, including the enquiry update
    expect((await db.enquiry.findUniqueOrThrow({ where: { id: e2.id } })).status).toBe("new");
  });
});

describe("price lists, tiers and MOQ", () => {
  const items = (id: string, body: unknown) => itemsPut(mk(`/api/admin/price-lists/${id}/items`, "PUT", owner.cookie, body), ctx({ id })).then(read);

  it("create (unique names), read, rename/deactivate, delete only when unused", async () => {
    const name = `m6-crud-${Date.now()}`;
    const created = await read(await listsPost(mk("/api/admin/price-lists", "POST", owner.cookie, { name, description: "Distributors" })));
    expect(created).toMatchObject({ status: 201, body: { priceList: { name, active: true } } });
    const id = created.body.priceList.id;
    expect(await read(await listsPost(mk("/api/admin/price-lists", "POST", owner.cookie, { name })))).toMatchObject({ status: 409, body: { code: "name_in_use" } });
    expect((await listsPost(mk("/api/admin/price-lists", "POST", owner.cookie, { name: "x" }))).status).toBe(422);
    expect((await read(await listPatch(mk(`/api/admin/price-lists/${id}`, "PATCH", owner.cookie, { active: false, description: null }), ctx({ id })))).body.priceList).toMatchObject({ active: false, description: null });
    expect((await listPatch(mk("/api/admin/price-lists/none", "PATCH", owner.cookie, { active: true }), ctx({ id: "none" }))).status).toBe(404);
    expect((await listPatch(mk(`/api/admin/price-lists/${id}`, "PATCH", owner.cookie, {}), ctx({ id }))).status).toBe(422);
    const b = await makeBuyer({ priceListId: id });
    expect(await read(await listDelete(mk(`/api/admin/price-lists/${id}`, "DELETE", owner.cookie), ctx({ id })))).toMatchObject({ status: 409, body: { code: "in_use" } });
    await db.businessAccount.update({ where: { id: b.account.id }, data: { priceListId: null } });
    expect((await listDelete(mk(`/api/admin/price-lists/${id}`, "DELETE", owner.cookie), ctx({ id }))).status).toBe(200);
    expect((await listDelete(mk(`/api/admin/price-lists/${id}`, "DELETE", owner.cookie), ctx({ id }))).status).toBe(404);
    expect((await read(await listsGet(mk("/api/admin/price-lists", "GET", owner.cookie)))).body.priceLists.map((l: any) => l.id)).not.toContain(id);
  });

  it("replaces a variant's tiers atomically, validates them, and the list read-back shows retail and MRP", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const mrp = (await db.variant.findUniqueOrThrow({ where: { id: v.variantId } })).mrp;
    const list = await createPriceList("tiers");
    const ok = await items(list.id, { variantId: v.variantId, tiers: [{ minQty: 100, unitPrice: 36000 }, { minQty: 10, unitPrice: 40000 }] });
    expect(ok).toMatchObject({ status: 200, body: { tiers: [{ minQty: 10, unitPrice: 40000 }, { minQty: 100, unitPrice: 36000 }] } });
    const read1 = await read(await listGet(mk(`/api/admin/price-lists/${list.id}`, "GET", owner.cookie), ctx({ id: list.id })));
    expect(read1.body.priceList.items).toEqual([
      { variantId: v.variantId, sku: expect.any(String), product: v.name, label: "250g", retailPrice: 50000, mrp, minQty: 10, unitPrice: 40000 },
      { variantId: v.variantId, sku: expect.any(String), product: v.name, label: "250g", retailPrice: 50000, mrp, minQty: 100, unitPrice: 36000 },
    ]);
    for (const [name, tiers] of [
      ["duplicate minQty", [{ minQty: 10, unitPrice: 40000 }, { minQty: 10, unitPrice: 39000 }]],
      ["price rises with quantity", [{ minQty: 10, unitPrice: 30000 }, { minQty: 100, unitPrice: 31000 }]],
      ["above MRP", [{ minQty: 1, unitPrice: mrp + 1 }]],
      ["zero price", [{ minQty: 1, unitPrice: 0 }]],
      ["fractional price", [{ minQty: 1, unitPrice: 10.5 }]],
      ["zero quantity", [{ minQty: 0, unitPrice: 100 }]],
    ] as const) expect((await items(list.id, { variantId: v.variantId, tiers })).status, name).toBe(422);
    expect((await read(await listGet(mk(`/api/admin/price-lists/${list.id}`, "GET", owner.cookie), ctx({ id: list.id })))).body.priceList.items).toHaveLength(2); // failed replacements changed nothing
    expect((await items(list.id, { variantId: v.variantId, tiers: [] })).status).toBe(200);
    expect(await db.priceListItem.count({ where: { priceListId: list.id } })).toBe(0);
    expect((await items("none", { variantId: v.variantId, tiers: [] })).status).toBe(404);
    expect((await items(list.id, { variantId: "none", tiers: [] })).status).toBe(404);
    expect((await items(list.id, { variantId: v.variantId, tiers: [], extra: 1 })).status).toBe(422);
  });

  it("the database refuses nonsensical prices and quantities", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const list = await createPriceList("db");
    await expect(db.priceListItem.create({ data: { priceListId: list.id, variantId: v.variantId, minQty: 0, unitPrice: 100 } })).rejects.toThrow(/PriceListItem_values_check/);
    await expect(db.priceListItem.create({ data: { priceListId: list.id, variantId: v.variantId, minQty: 1, unitPrice: 0 } })).rejects.toThrow(/PriceListItem_values_check/);
    await expect(db.variantWholesale.create({ data: { variantId: v.variantId, moq: 0, casePack: 1 } })).rejects.toThrow(/VariantWholesale_values_check/);
  });

  it("sets and updates a variant's MOQ and case pack (and audits it)", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const put = (body: unknown, id = v.variantId) => termsPut(mk(`/api/admin/variants/${id}/wholesale`, "PUT", owner.cookie, body), ctx({ id })).then(read);
    expect(await put({ moq: 24, casePack: 12 })).toMatchObject({ status: 200, body: { moq: 24, casePack: 12 } });
    expect(await put({ moq: 48, casePack: 12 })).toMatchObject({ body: { moq: 48 } });
    expect(await db.variantWholesale.findUniqueOrThrow({ where: { variantId: v.variantId } })).toMatchObject({ moq: 48, casePack: 12 });
    for (const bad of [{ moq: 0, casePack: 1 }, { moq: 1, casePack: 0 }, { moq: 1.5, casePack: 1 }, { moq: 1 }, { moq: 1, casePack: 1, extra: 1 }]) expect((await put(bad)).status).toBe(422);
    expect((await put({ moq: 1, casePack: 1 }, "none")).status).toBe(404);
    expect((await audit("variant.wholesale")).map((a) => a.outcome)).toEqual(["success", "success", "rejected"]);
  });
});

describe("account deletion with a business account (M5 interplay)", () => {
  it("is refused while the account is live, allowed once closed (contact details anonymised, company identity kept); export includes it", async () => {
    const b = await makeBuyer();
    const ex = JSON.parse(await (await exportData(mk("/api/account/export", "GET", b.cookie))).text());
    expect(ex.businessAccount).toMatchObject({ companyName: "Rao Traders", status: "approved", quotes: [] });
    const del = () => deleteAccount(mk("/api/account", "DELETE", b.cookie, { confirm: "DELETE" })).then(read);
    expect(await del()).toMatchObject({ status: 409, body: { code: "business_account" } });
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "closed", adminNote: "internal" } });
    expect((await del()).status).toBe(200);
    expect(await db.customer.count({ where: { id: b.customerId } })).toBe(0);
    expect(await db.businessAccount.findUniqueOrThrow({ where: { id: b.account.id } })).toMatchObject({ customerId: null, contactName: "Erased", contactEmail: "erased@erased.invalid", phone: "0000000000", adminNote: null, companyName: "Rao Traders", gstin: b.account.gstin });
  });
});
