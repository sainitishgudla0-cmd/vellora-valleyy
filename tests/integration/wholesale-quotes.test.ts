/** M6-T4: quote lifecycle: request → price → accept (order at quoted prices) / decline / expire, atomicity and races. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { expireQuotes } from "@/lib/wholesale/quotes";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant, variantState } from "../support/inventory";
import { cleanupWholesaleFixtures, makeBuyer, setTerms, SHIPPING } from "../support/wholesale";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { GET as quotesList, POST as quoteCreate } from "@/app/api/business/quotes/route";
import { GET as quoteGet, DELETE as quoteCancel } from "@/app/api/business/quotes/[number]/route";
import { POST as quoteAccept } from "@/app/api/business/quotes/[number]/accept/route";
import { POST as quoteDecline } from "@/app/api/business/quotes/[number]/decline/route";
import { GET as adminQuotes } from "@/app/api/admin/quotes/route";
import { GET as adminQuoteGet, PATCH as adminQuotePatch } from "@/app/api/admin/quotes/[id]/route";
import { PATCH as adminAccountPatch } from "@/app/api/admin/wholesale/accounts/[id]/route";
import { GET as expireRoute } from "@/app/api/internal/orders/expire/route";

type Buyer = Awaited<ReturnType<typeof makeBuyer>>;
const mk = (url: string, method: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

let admin: Awaited<ReturnType<typeof createTestAdmin>>;
beforeEach(async () => {
  customerTestEnv();
  vi.stubEnv("PAYMENT_MODE", "request_only");
  rate.rateLimit.mockResolvedValue(true);
  admin ??= await createTestAdmin("owner");
});
afterAll(async () => {
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupWholesaleFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

const request = async (b: Buyer, items: { variantId: string; quantity: number }[], note?: string) => {
  const r = await read(await quoteCreate(mk("/api/business/quotes", "POST", b.cookie, { items, note })));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { number: r.body.quote.number as string, id: (await db.quote.findUniqueOrThrow({ where: { number: r.body.quote.number } })).id };
};
const price = (id: string, items: { variantId: string; unitPrice: number }[], extra: Record<string, unknown> = {}, cookie = admin.cookie) =>
  adminQuotePatch(mk(`/api/admin/quotes/${id}`, "PATCH", cookie, { action: "quote", items, ...extra }), ctx({ id })).then(read);
const accept = (b: Buyer, number: string, body: Record<string, unknown> = SHIPPING) => quoteAccept(mk(`/api/business/quotes/${number}/accept`, "POST", b.cookie, body), ctx({ number })).then(read);
const view = (b: Buyer, number: string) => quoteGet(mk(`/api/business/quotes/${number}`, "GET", b.cookie), ctx({ number })).then(read);
const statusOf = async (number: string) => (await db.quote.findUniqueOrThrow({ where: { number } })).status;

describe("requesting a quote", () => {
  it("records the request with snapshots and shows no price until staff quote", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const w = await createInventoryVariant({ tracked: false, price: 30000 });
    const b = await makeBuyer();
    const r = await read(await quoteCreate(mk("/api/business/quotes", "POST", b.cookie, { items: [{ variantId: v.variantId, quantity: 100 }, { variantId: w.variantId, quantity: 50 }, { variantId: v.variantId, quantity: 20 }], note: "Need by month end" })));
    expect(r.status).toBe(201);
    const q = r.body.quote;
    expect(q).toMatchObject({ status: "requested", requestNote: "Need by month end", orderNumber: null });
    expect(q.number).toMatch(/^QT-\d{6}-[0-9A-F]{6}$/);
    expect(q.items).toHaveLength(2);
    expect(q.items.find((i: any) => i.variantId === v.variantId)).toMatchObject({ quantity: 120, productName: v.name });
    expect(JSON.stringify(q)).not.toMatch(/unitPrice|lineTotal|subtotal|total/); // nothing priced yet
    expect((await read(await quotesList(mk("/api/business/quotes", "GET", b.cookie)))).body.quotes).toHaveLength(1);
  });

  it("enforces MOQ / case packs, availability and shape at request time", async () => {
    const v = await createInventoryVariant({ tracked: false });
    await setTerms(v.variantId, 24, 12);
    const hidden = await createInventoryVariant({ tracked: false, productActive: false });
    const b = await makeBuyer();
    const post = (items: unknown) => quoteCreate(mk("/api/business/quotes", "POST", b.cookie, { items })).then(read);
    expect(await post([{ variantId: v.variantId, quantity: 12 }])).toMatchObject({ status: 422, body: { fields: { [v.variantId]: expect.stringContaining("Minimum order is 24") } } });
    expect((await post([{ variantId: v.variantId, quantity: 30 }])).status).toBe(422);
    expect((await post([{ variantId: hidden.variantId, quantity: 5 }])).status).toBe(422);
    expect((await post([{ variantId: "missing", quantity: 5 }])).status).toBe(422);
    expect((await post([])).status).toBe(422);
    expect((await post([{ variantId: v.variantId, quantity: 24, unitPrice: 1 }])).status).toBe(422);
    expect((await post([{ variantId: v.variantId, quantity: 24 }])).status).toBe(201);
    rate.rateLimit.mockResolvedValue(false);
    expect((await post([{ variantId: v.variantId, quantity: 24 }])).status).toBe(429);
  });
});

describe("pricing and accepting", () => {
  it("requested → quoted → accepted: the order carries exactly the quoted prices, delivery fee and total", async () => {
    const v = await createInventoryVariant({ stock: 1000, price: 50000 });
    const w = await createInventoryVariant({ stock: 1000, price: 30000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 200 }, { variantId: w.variantId, quantity: 60 }]);
    const p = await price(q.id, [{ variantId: v.variantId, unitPrice: 41000 }, { variantId: w.variantId, unitPrice: 25500 }], { deliveryFee: 150000, validDays: 10, buyerNote: "Ex-warehouse Anantapur; 30 days" });
    expect(p).toMatchObject({ status: 200, body: { ok: true, quote: { status: "quoted", total: 200 * 41000 + 60 * 25500 + 150000 } } });
    const seen = (await view(b, q.number)).body.quote;
    expect(seen).toMatchObject({ status: "quoted", subtotal: 9_730_000, deliveryFee: 150_000, total: 9_880_000, buyerNote: "Ex-warehouse Anantapur; 30 days" });
    expect(seen.items.map((i: any) => [i.quantity, i.unitPrice, i.lineTotal]).sort()).toEqual([[200, 41000, 8_200_000], [60, 25500, 1_530_000]].sort());
    const days = (new Date(seen.validUntil).getTime() - new Date(seen.quotedAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(10, 1);

    const a = await accept(b, q.number, { ...SHIPPING, notes: "Gate 2" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.order.total).toBe(9_880_000);
    const order = await db.order.findUniqueOrThrow({ where: { number: a.body.order.number }, include: { items: true } });
    expect(order).toMatchObject({ subtotal: 9_730_000, deliveryFee: 150_000, total: 9_880_000, businessAccountId: b.account.id, customerId: b.customerId, status: "pending_confirmation", paymentMethod: "cod", notes: "Gate 2" });
    expect(order.items.map((i) => [i.variantId, i.quantity, i.unitPrice]).sort()).toEqual([[v.variantId, 200, 41000], [w.variantId, 60, 25500]].sort());
    const done = await db.quote.findUniqueOrThrow({ where: { number: q.number }, include: { events: { orderBy: { createdAt: "asc" } } } });
    expect(done).toMatchObject({ status: "accepted", orderId: order.id });
    expect(done.events.map((e) => `${e.fromStatus}>${e.toStatus}:${e.actorType}`)).toEqual(["requested>quoted:admin", "quoted>accepted:customer"]);
    expect((await view(b, q.number)).body.quote).toMatchObject({ status: "accepted", orderNumber: order.number });
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 200 });
  });

  it("prices stay frozen: later list or retail changes do not touch an accepted quote's order", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 33000 }], { deliveryFee: 0 });
    await db.variant.update({ where: { id: v.variantId }, data: { price: 99000 } });
    const a = await accept(b, q.number);
    expect(a.status).toBe(201);
    expect((await db.orderItem.findFirstOrThrow({ where: { order: { number: a.body.order.number } } })).unitPrice).toBe(33000);
    expect(a.body.order.total).toBe(330000);
  });

  it("re-quoting a quoted quote replaces the prices (the buyer only ever sees the latest)", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 40000 }], { deliveryFee: 0 });
    await price(q.id, [{ variantId: v.variantId, unitPrice: 38000 }], { deliveryFee: 0 });
    expect((await view(b, q.number)).body.quote.total).toBe(380000);
    await expect(accept(b, q.number)).resolves.toMatchObject({ body: { order: { total: 380000 } } });
  });

  it("staff pricing is validated: every line once, positive, not above MRP, validity bounded; failures change nothing", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const w = await createInventoryVariant({ tracked: false, price: 30000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }, { variantId: w.variantId, quantity: 10 }]);
    const mrp = (await db.variant.findUniqueOrThrow({ where: { id: v.variantId } })).mrp;
    const bad: [string, Parameters<typeof price>[1], Record<string, unknown>][] = [
      ["missing line", [{ variantId: v.variantId, unitPrice: 100 }], {}],
      ["unknown variant", [{ variantId: v.variantId, unitPrice: 100 }, { variantId: "nope", unitPrice: 100 }], {}],
      ["duplicate line", [{ variantId: v.variantId, unitPrice: 100 }, { variantId: v.variantId, unitPrice: 100 }], {}],
      ["above MRP", [{ variantId: v.variantId, unitPrice: mrp + 1 }, { variantId: w.variantId, unitPrice: 100 }], {}],
    ];
    for (const [name, items, extra] of bad) expect((await price(q.id, items, extra)).status, name).toBe(422);
    expect((await price(q.id, [{ variantId: v.variantId, unitPrice: 100 }, { variantId: w.variantId, unitPrice: 100 }], { validDays: 31 })).status).toBe(422);
    expect((await price(q.id, [{ variantId: v.variantId, unitPrice: 0 }, { variantId: w.variantId, unitPrice: 100 }])).status).toBe(422);
    expect((await price(q.id, [{ variantId: v.variantId, unitPrice: 1.5 }, { variantId: w.variantId, unitPrice: 100 }])).status).toBe(422);
    expect(await db.quote.findUniqueOrThrow({ where: { id: q.id }, include: { items: true } })).toMatchObject({ status: "requested", total: null });
    expect((await db.quoteItem.findMany({ where: { quoteId: q.id } })).every((i) => i.unitPrice === null)).toBe(true);
  });

  it("can only be accepted while quoted: not before pricing, not twice, not after decline", async () => {
    const v = await createInventoryVariant({ stock: 100, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }]);
    expect(await accept(b, q.number)).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    await price(q.id, [{ variantId: v.variantId, unitPrice: 40000 }]);
    expect((await accept(b, q.number)).status).toBe(201);
    expect(await accept(b, q.number)).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(1);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 10 });
  });

  it("two parallel accepts create exactly one order", async () => {
    const v = await createInventoryVariant({ stock: 1000, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 100 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 40000 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => accept(b, q.number)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(1);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 100 });
  });

  it("insufficient stock refuses the acceptance and leaves the quote quoted (nothing half-done)", async () => {
    const v = await createInventoryVariant({ stock: 50, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 80 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 40000 }]);
    const r = await accept(b, q.number);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Only 50 of/);
    expect(await statusOf(q.number)).toBe("quoted");
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 0 });
    await db.inventoryMovement.create({ data: { variantId: v.variantId, reason: "adjustment", stockDelta: 30, reservedDelta: 0, stockAfter: 80, reservedAfter: 0, note: "restock", actorType: "admin" } });
    await db.variant.update({ where: { id: v.variantId }, data: { stockQuantity: 80, inStock: true } });
    expect((await accept(b, q.number)).status).toBe(201); // the same quote works once there is stock
  });

  it("the credit limit applies to acceptance; a refused acceptance keeps the quote open", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 100_000 });
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 40000 }], { deliveryFee: 0 }); // 400,000 > 100,000
    const r = await accept(b, q.number);
    expect(r).toMatchObject({ status: 409 });
    expect(r.body.error).toMatch(/credit limit/);
    expect(await statusOf(q.number)).toBe("quoted");
    await db.businessAccount.update({ where: { id: b.account.id }, data: { creditLimit: 500_000 } });
    expect((await accept(b, q.number)).status).toBe(201);
  });

  it("validates the delivery details and refuses unknown fields", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    for (const bad of [{}, { ...SHIPPING, pincode: "12" }, { ...SHIPPING, total: 1 }, { ...SHIPPING, items: [] }, { ...SHIPPING, paymentMethod: "razorpay" }]) expect((await accept(b, q.number, bad)).status).toBe(422);
    expect(await statusOf(q.number)).toBe("quoted");
  });
});

describe("expiry", () => {
  it("an expired quote cannot be accepted (and is marked expired); the sweep and the cron route expire the rest", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const q1 = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    const q2 = await request(b, [{ variantId: v.variantId, quantity: 6 }]);
    const q3 = await request(b, [{ variantId: v.variantId, quantity: 7 }]);
    for (const q of [q1, q2, q3]) await price(q.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    const past = new Date(Date.now() - 60_000);
    await db.quote.updateMany({ where: { id: { in: [q1.id, q2.id] } }, data: { validUntil: past } });
    expect(await accept(b, q1.number)).toMatchObject({ status: 409, body: { code: "quote_expired" } });
    expect(await statusOf(q1.number)).toBe("expired");
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
    expect(await expireQuotes()).toBe(1); // q2 only: q1 already expired, q3 still valid
    expect(await statusOf(q2.number)).toBe("expired");
    expect(await statusOf(q3.number)).toBe("quoted");
    expect(await expireQuotes()).toBe(0);
    expect((await db.quoteEvent.findMany({ where: { quoteId: q2.id } })).map((e) => `${e.toStatus}:${e.actorType}`)).toContain("expired:system");
    // the scheduled route reports it too
    await db.quote.update({ where: { id: q3.id }, data: { validUntil: past } });
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret-0123456789abcdef");
    const res = await read(await expireRoute(new Request("http://localhost/api/internal/orders/expire", { headers: { authorization: "Bearer test-only-cron-secret-0123456789abcdef" } })));
    expect(res.body.quotesExpired).toBe(1);
    expect(await statusOf(q3.number)).toBe("expired");
  });

  it("a quote that expires between the check and the claim is refused and rolls the order back", async () => {
    const v = await createInventoryVariant({ stock: 100, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 10 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    // expire it as soon as the order insert starts: a trigger on Order flips validUntil into the past
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION m6_expire() RETURNS trigger AS $$ BEGIN UPDATE "Quote" SET "validUntil" = now() - interval '1 minute' WHERE "number" = '${q.number}'; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER m6_expire AFTER INSERT ON "Order" FOR EACH ROW EXECUTE FUNCTION m6_expire()`);
    try {
      expect(await accept(b, q.number)).toMatchObject({ status: 409, body: { code: "quote_expired" } });
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER m6_expire ON "Order"`);
      await db.$executeRawUnsafe(`DROP FUNCTION m6_expire()`);
    }
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 0 });
  });
});

describe("declining, cancelling, rejecting and closing", () => {
  it("the buyer declines a quoted quote and withdraws a requested one; staff reject or cancel; terminal states stay terminal", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const quoted = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    await price(quoted.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    expect((await read(await quoteDecline(mk(`/api/business/quotes/${quoted.number}/decline`, "POST", b.cookie), ctx({ number: quoted.number })))).status).toBe(200);
    expect(await statusOf(quoted.number)).toBe("declined");
    expect((await read(await quoteDecline(mk(`/api/business/quotes/${quoted.number}/decline`, "POST", b.cookie), ctx({ number: quoted.number })))).body.code).toBe("invalid_transition");
    expect((await accept(b, quoted.number)).status).toBe(409);

    const requested = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    expect((await read(await quoteDecline(mk(`/api/business/quotes/${requested.number}/decline`, "POST", b.cookie), ctx({ number: requested.number })))).status).toBe(409); // nothing to decline yet
    expect((await quoteCancel(mk(`/api/business/quotes/${requested.number}`, "DELETE", b.cookie), ctx({ number: requested.number }))).status).toBe(200);
    expect(await statusOf(requested.number)).toBe("cancelled");

    const toReject = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    const rej = await adminQuotePatch(mk(`/api/admin/quotes/${toReject.id}`, "PATCH", admin.cookie, { action: "reject" }), ctx({ id: toReject.id }));
    expect(rej.status).toBe(200);
    expect(await statusOf(toReject.number)).toBe("rejected");
    expect((await price(toReject.id, [{ variantId: v.variantId, unitPrice: 100 }])).status).toBe(409); // cannot price a rejected quote

    const toCancel = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    await price(toCancel.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    expect((await adminQuotePatch(mk(`/api/admin/quotes/${toCancel.id}`, "PATCH", admin.cookie, { action: "cancel" }), ctx({ id: toCancel.id }))).status).toBe(200);
    expect((await accept(b, toCancel.number)).status).toBe(409);
  });

  it("suspending blocks acceptance; closing the account cancels its open quotes in the same step", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const open = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    const quoted = await request(b, [{ variantId: v.variantId, quantity: 6 }]);
    await price(quoted.id, [{ variantId: v.variantId, unitPrice: 100 }]);
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "suspended" } });
    expect((await accept(b, quoted.number)).status).toBe(403);
    await db.businessAccount.update({ where: { id: b.account.id }, data: { status: "approved" } });
    const r = await adminAccountPatch(mk(`/api/admin/wholesale/accounts/${b.account.id}`, "PATCH", admin.cookie, { status: "closed" }), ctx({ id: b.account.id }));
    expect(r.status).toBe(200);
    expect(await statusOf(open.number)).toBe("cancelled");
    expect(await statusOf(quoted.number)).toBe("cancelled");
    expect((await db.quoteEvent.findMany({ where: { quoteId: quoted.id } })).map((e) => e.toStatus)).toContain("cancelled");
  });
});

describe("admin quote endpoints", () => {
  it("list by status, show the full quote with its history, and audit every move without prices or notes", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    const q = await request(b, [{ variantId: v.variantId, quantity: 5 }]);
    await price(q.id, [{ variantId: v.variantId, unitPrice: 12345 }], { buyerNote: "BUYER-NOTE-TEXT" });
    const list = await read(await adminQuotes(mk("/api/admin/quotes?status=quoted", "GET", admin.cookie)));
    expect(list.body.quotes.map((x: any) => x.number)).toContain(q.number);
    expect(list.body.quotes.find((x: any) => x.number === q.number)).toMatchObject({ company: "Rao Traders", status: "quoted", total: 5 * 12345 + (await db.quote.findUniqueOrThrow({ where: { id: q.id } })).deliveryFee! });
    expect((await adminQuotes(mk("/api/admin/quotes?status=bogus", "GET", admin.cookie))).status).toBe(422);
    const one = await read(await adminQuoteGet(mk(`/api/admin/quotes/${q.id}`, "GET", admin.cookie), ctx({ id: q.id })));
    expect(one.body.quote).toMatchObject({ number: q.number, status: "quoted", businessAccount: { companyName: "Rao Traders" } });
    expect(one.body.quote.events.map((e: any) => e.toStatus)).toEqual(["quoted"]);
    expect((await adminQuoteGet(mk("/api/admin/quotes/none", "GET", admin.cookie), ctx({ id: "none" }))).status).toBe(404);
    const rows = JSON.stringify(await db.auditLog.findMany({ where: { action: { startsWith: "quote." } } }));
    expect(rows).toContain("quote.quote");
    for (const secret of ["12345", "BUYER-NOTE-TEXT"]) expect(rows, secret).not.toContain(secret);
  });
});
