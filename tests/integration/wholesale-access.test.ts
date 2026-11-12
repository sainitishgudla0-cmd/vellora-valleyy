/** M6: business accounts: application, approval gating, authz matrix, price-leakage tests, linking by email. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessAccountStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail, signInCustomer } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupWholesaleFixtures, createPriceList, makeBuyer, makeGstin, setTerms, SHIPPING } from "../support/wholesale";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as apply } from "@/app/api/business/apply/route";
import { GET as accountGet } from "@/app/api/business/account/route";
import { GET as priceListGet } from "@/app/api/business/price-list/route";
import { POST as bizCartValidate } from "@/app/api/business/cart/validate/route";
import { POST as bizOrder } from "@/app/api/business/orders/route";
import { GET as quotesList, POST as quoteCreate } from "@/app/api/business/quotes/route";
import { GET as quoteGet, DELETE as quoteCancel } from "@/app/api/business/quotes/[number]/route";
import { POST as quoteAccept } from "@/app/api/business/quotes/[number]/accept/route";
import { POST as quoteDecline } from "@/app/api/business/quotes/[number]/decline/route";
import { POST as retailOrder } from "@/app/api/orders/route";
import { POST as retailCartValidate } from "@/app/api/cart/validate/route";
import { GET as productsGet } from "@/app/api/products/route";
import { GET as productGet } from "@/app/api/products/[slug]/route";

const mk = (url: string, method: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = (number: string) => ({ params: Promise.resolve({ number }) });

beforeEach(async () => {
  customerTestEnv();
  vi.stubEnv("PAYMENT_MODE", "request_only");
  rate.rateLimit.mockResolvedValue(true);
  await db.otpChallenge.deleteMany({});
});
afterAll(async () => {
  await cleanupWholesaleFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

const APPLICATION = () => ({ companyName: "Rao Traders", gstin: makeGstin(), contactName: "Asha Rao", phone: "9876543210", interest: "retail", message: "Supermarket chain in Anantapur" });

describe("applying", () => {
  it("a signed-in customer applies; the account starts pending and the response shows no staff-only data", async () => {
    const c = await signInCustomer();
    const body = APPLICATION();
    const r = await read(await apply(mk("/api/business/apply", "POST", c.cookie, body)));
    expect(r).toMatchObject({ status: 201, body: { account: { status: "pending", companyName: "Rao Traders", gstin: body.gstin } } });
    const row = await db.businessAccount.findUniqueOrThrow({ where: { customerId: c.customerId } });
    expect(row).toMatchObject({ status: "pending", contactEmail: c.email, paymentTerms: "prepaid", creditLimit: 0, priceListId: null });
    const mine = await read(await accountGet(mk("/api/business/account", "GET", c.cookie)));
    expect(mine.body.account).toMatchObject({ status: "pending", companyName: "Rao Traders" });
    expect(JSON.stringify(mine.body)).not.toMatch(/adminNote|priceListId/);
  });

  it("needs a session, a valid GSTIN (format and check character), and rejects unknown fields", async () => {
    expect((await apply(mk("/api/business/apply", "POST", undefined, APPLICATION()))).status).toBe(401);
    const c = await signInCustomer();
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, { ...APPLICATION(), gstin: "27AAPFU0939F1ZW" }))).status).toBe(422);
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, { ...APPLICATION(), gstin: "123" }))).status).toBe(422);
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, { ...APPLICATION(), status: "approved" }))).status).toBe(422); // cannot approve yourself
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, { ...APPLICATION(), customerId: "x" }))).status).toBe(422);
    expect(await db.businessAccount.count({ where: { customerId: c.customerId } })).toBe(0);
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, APPLICATION(), { origin: "https://evil.example" }))).status).toBe(403);
    rate.rateLimit.mockResolvedValue(false);
    expect((await apply(mk("/api/business/apply", "POST", c.cookie, APPLICATION()))).status).toBe(429);
  });

  it("one application per customer, one live account per GSTIN; a rejected applicant may correct and re-apply", async () => {
    const a = await signInCustomer();
    const body = APPLICATION();
    expect((await apply(mk("/api/business/apply", "POST", a.cookie, body))).status).toBe(201);
    expect(await read(await apply(mk("/api/business/apply", "POST", a.cookie, APPLICATION())))).toMatchObject({ status: 409, body: { code: "already_applied" } });
    const b = await signInCustomer();
    expect(await read(await apply(mk("/api/business/apply", "POST", b.cookie, { ...APPLICATION(), gstin: body.gstin })))).toMatchObject({ status: 409, body: { code: "gstin_in_use" } });
    await db.businessAccount.update({ where: { customerId: a.customerId }, data: { status: "rejected", adminNote: "docs unclear" } });
    const again = await read(await apply(mk("/api/business/apply", "POST", a.cookie, { ...APPLICATION(), companyName: "Rao Traders Pvt Ltd" })));
    expect(again).toMatchObject({ status: 201, body: { account: { status: "pending", companyName: "Rao Traders Pvt Ltd" } } });
    expect((await db.businessAccount.findUniqueOrThrow({ where: { customerId: a.customerId } })).adminNote).toBeNull();
    // a rejected account frees its GSTIN for someone else
    await db.businessAccount.update({ where: { customerId: a.customerId }, data: { status: "rejected" } });
    expect((await apply(mk("/api/business/apply", "POST", b.cookie, { ...APPLICATION(), gstin: (await db.businessAccount.findUniqueOrThrow({ where: { customerId: a.customerId } })).gstin }))).status).toBe(201);
    // a closed account cannot re-apply
    const c = await signInCustomer();
    await apply(mk("/api/business/apply", "POST", c.cookie, APPLICATION()));
    await db.businessAccount.update({ where: { customerId: c.customerId }, data: { status: "closed" } });
    expect(await read(await apply(mk("/api/business/apply", "POST", c.cookie, APPLICATION())))).toMatchObject({ status: 409, body: { code: "already_applied" } });
  });

  it("the database allows only one live account per GSTIN", async () => {
    const g = makeGstin();
    const mkAcc = (status: BusinessAccountStatus) => db.businessAccount.create({ data: { contactEmail: freshEmail("x"), companyName: "Rao Traders", gstin: g, contactName: "A", phone: "9876543210", status } });
    await mkAcc("approved");
    await expect(mkAcc("pending")).rejects.toThrow(/Unique constraint/);
    await mkAcc("rejected");
    await mkAcc("closed");
  });
});

describe("approval gating (authz matrix)", () => {
  const ROUTES: [string, (cookie?: string) => Promise<Response>][] = [
    ["GET price-list", (c) => priceListGet(mk("/api/business/price-list", "GET", c))],
    ["POST cart/validate", (c) => bizCartValidate(mk("/api/business/cart/validate", "POST", c, { items: [{ variantId: "x", quantity: 1 }] }))],
    ["POST orders", (c) => bizOrder(mk("/api/business/orders", "POST", c, { ...SHIPPING, items: [{ variantId: "x", quantity: 1 }] }))],
    ["GET quotes", (c) => quotesList(mk("/api/business/quotes", "GET", c))],
    ["POST quotes", (c) => quoteCreate(mk("/api/business/quotes", "POST", c, { items: [{ variantId: "x", quantity: 1 }] }))],
    ["GET quotes/[n]", (c) => quoteGet(mk("/api/business/quotes/QT-1", "GET", c), ctx("QT-1"))],
    ["DELETE quotes/[n]", (c) => quoteCancel(mk("/api/business/quotes/QT-1", "DELETE", c), ctx("QT-1"))],
    ["POST quotes/[n]/accept", (c) => quoteAccept(mk("/api/business/quotes/QT-1/accept", "POST", c, SHIPPING), ctx("QT-1"))],
    ["POST quotes/[n]/decline", (c) => quoteDecline(mk("/api/business/quotes/QT-1/decline", "POST", c), ctx("QT-1"))],
  ];

  it.each(ROUTES)("%s: 401 anonymous, 403 for retail customers and for every non-approved status, never 403 for an approved buyer", async (_n, call) => {
    expect((await call()).status).toBe(401);
    expect((await call("vv_customer=garbage")).status).toBe(401);
    const retail = await signInCustomer();
    expect(await read(await call(retail.cookie))).toMatchObject({ status: 403, body: { code: "business_account_required" } });
    for (const status of ["pending", "rejected", "suspended", "closed"] as const) {
      const b = await makeBuyer({ status });
      expect(await read(await call(b.cookie)), status).toMatchObject({ status: 403, body: { code: "business_account_not_active", status } });
    }
    const ok = await makeBuyer({ status: "approved" });
    expect([401, 403]).not.toContain((await call(ok.cookie)).status);
  });

  it("an admin session is not a customer session and a customer session is not an admin one", async () => {
    const admin = await createTestAdmin("owner");
    expect((await priceListGet(mk("/api/business/price-list", "GET", admin.cookie))).status).toBe(401);
    const b = await makeBuyer();
    const { GET: adminAccounts } = await import("@/app/api/admin/wholesale/accounts/route");
    expect((await adminAccounts(mk("/api/admin/wholesale/accounts", "GET", b.cookie))).status).toBe(401);
  });

  it("business mutations refuse cross-origin requests", async () => {
    const b = await makeBuyer();
    expect((await quoteCreate(mk("/api/business/quotes", "POST", b.cookie, { items: [{ variantId: "x", quantity: 1 }] }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("suspending an approved account takes effect immediately; re-approving restores it", async () => {
    const b = await makeBuyer();
    expect((await priceListGet(mk("/api/business/price-list", "GET", b.cookie))).status).toBe(200);
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "suspended" } });
    expect((await priceListGet(mk("/api/business/price-list", "GET", b.cookie))).status).toBe(403);
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "approved" } });
    expect((await priceListGet(mk("/api/business/price-list", "GET", b.cookie))).status).toBe(200);
  });
});

describe("a staff-created account is linked to the verified owner of its email", () => {
  it("links on first use, only for that address, only once", async () => {
    const email = freshEmail("converted");
    const acc = await db.businessAccount.create({ data: { contactEmail: email, companyName: "Rao Traders", gstin: makeGstin(), contactName: "Asha", phone: "9876543210", status: "approved", approvedAt: new Date() } });
    const stranger = await signInCustomer();
    expect((await priceListGet(mk("/api/business/price-list", "GET", stranger.cookie))).status).toBe(403); // not their address
    const owner = await signInCustomer(email);
    expect((await priceListGet(mk("/api/business/price-list", "GET", owner.cookie))).status).toBe(200);
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: acc.id } })).customerId).toBe(owner.customerId);
    expect((await priceListGet(mk("/api/business/price-list", "GET", stranger.cookie))).status).toBe(403);
  });
});

describe("price leakage: wholesale prices never reach retail", () => {
  it("retail endpoints are byte-for-byte unaffected by price lists, even for a signed-in approved buyer", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const SECRET = 31337; // a wholesale price that appears nowhere else
    const list = await createPriceList("leak", [{ variantId: v.variantId, tiers: [{ minQty: 1, unitPrice: SECRET }] }]);
    await setTerms(v.variantId, 7, 7);
    const buyer = await makeBuyer({ priceListId: list.id });

    const slug = v.product.slug;
    const products = await (await productsGet(mk("/api/products", "GET"))).text();
    const product = await (await productGet(mk(`/api/products/${slug}`, "GET"), { params: Promise.resolve({ slug }) })).text();
    const anonCart = await (await retailCartValidate(mk("/api/cart/validate", "POST", undefined, { variantIds: [v.variantId] }))).text();
    const buyerCart = await (await retailCartValidate(mk("/api/cart/validate", "POST", buyer.cookie, { variantIds: [v.variantId] }))).text();
    for (const [name, text] of Object.entries({ products, product, anonCart, buyerCart })) expect(text, name).not.toContain(String(SECRET));
    expect(JSON.parse(product).product.variants[0]).toMatchObject({ price: 50000 });
    expect(JSON.parse(anonCart).variants[0]).toMatchObject({ price: 50000 });
    expect(buyerCart).toBe(anonCart); // identical for the buyer and for an anonymous visitor
    expect(Object.keys(JSON.parse(anonCart).variants[0]).sort()).toEqual(["available", "id", "mrp", "price"]);

    // a retail order placed by the buyer is charged retail, ignores MOQ, and is not linked to the business account
    const r = await read(await retailOrder(mk("/api/orders", "POST", buyer.cookie, { ...SHIPPING, paymentMethod: "cod", items: [{ variantId: v.variantId, quantity: 1 }] })));
    expect(r.status).toBe(201);
    const o = await db.order.findUniqueOrThrow({ where: { number: r.body.order.number }, include: { items: true } });
    expect(o.items[0].unitPrice).toBe(50000);
    expect(o.businessAccountId).toBeNull();
    expect(o.total).toBe(50000 + o.deliveryFee);
  });

  it("the buyer's price-list endpoint shows only THEIR list; another account's tiers are unreachable", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 60000 });
    const listA = await createPriceList("A", [{ variantId: v.variantId, tiers: [{ minQty: 10, unitPrice: 41111 }, { minQty: 100, unitPrice: 40000 }] }]);
    const listB = await createPriceList("B", [{ variantId: v.variantId, tiers: [{ minQty: 1, unitPrice: 52222 }] }]);
    const a = await makeBuyer({ priceListId: listA.id });
    const b = await makeBuyer({ priceListId: listB.id });
    const none = await makeBuyer({ priceListId: null });
    await setTerms(v.variantId, 10, 5);
    const ra = await read(await priceListGet(mk("/api/business/price-list", "GET", a.cookie)));
    expect(ra.body.items).toEqual([{ variantId: v.variantId, sku: expect.any(String), product: v.name, label: "250g", retailPrice: 60000, moq: 10, casePack: 5, tiers: [{ minQty: 10, unitPrice: 41111 }, { minQty: 100, unitPrice: 40000 }] }]);
    expect(JSON.stringify(ra.body)).not.toContain("52222");
    expect(JSON.stringify((await read(await priceListGet(mk("/api/business/price-list", "GET", b.cookie)))).body)).not.toContain("41111");
    expect((await read(await priceListGet(mk("/api/business/price-list", "GET", none.cookie)))).body.items).toEqual([]);
    // an inactive list shows nothing
    await db.priceList.update({ where: { id: listA.id }, data: { active: false } });
    expect((await read(await priceListGet(mk("/api/business/price-list", "GET", a.cookie)))).body.items).toEqual([]);
  });

  it("someone else's quote is a 404 (get, cancel, accept, decline), identical to an unknown number", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const a = await makeBuyer();
    const b = await makeBuyer();
    const q = (await read(await quoteCreate(mk("/api/business/quotes", "POST", a.cookie, { items: [{ variantId: v.variantId, quantity: 5 }] })))).body.quote.number;
    const attempts = [
      quoteGet(mk(`/api/business/quotes/${q}`, "GET", b.cookie), ctx(q)),
      quoteCancel(mk(`/api/business/quotes/${q}`, "DELETE", b.cookie), ctx(q)),
      quoteAccept(mk(`/api/business/quotes/${q}/accept`, "POST", b.cookie, SHIPPING), ctx(q)),
      quoteDecline(mk(`/api/business/quotes/${q}/decline`, "POST", b.cookie), ctx(q)),
      quoteGet(mk("/api/business/quotes/QT-000000-NOPE00", "GET", b.cookie), ctx("QT-000000-NOPE00")),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
    expect((await read(await quotesList(mk("/api/business/quotes", "GET", b.cookie)))).body.quotes).toEqual([]);
    expect((await db.quote.findUniqueOrThrow({ where: { number: q } })).status).toBe("requested");
  });
});
