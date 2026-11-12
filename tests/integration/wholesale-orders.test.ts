/** M6-T2/T3: price resolution, MOQ and case packs, bulk quantities, credit limits and stock for direct wholesale orders. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/state-machine";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { cleanupCustomerFixtures, customerTestEnv } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant, variantState } from "../support/inventory";
import { cleanupWholesaleFixtures, createPriceList, makeBuyer, setTerms, SHIPPING } from "../support/wholesale";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as bizOrder } from "@/app/api/business/orders/route";
import { POST as bizCartValidate } from "@/app/api/business/cart/validate/route";
import { POST as retailOrder } from "@/app/api/orders/route";

const mk = (url: string, cookie: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const order = (cookie: string, items: { variantId: string; quantity: number }[], headers: Record<string, string> = {}) => bizOrder(mk("/api/business/orders", cookie, { ...SHIPPING, items }, headers)).then(read);
const lines = (o: { number: string }) => db.orderItem.findMany({ where: { order: { number: o.number } } });

beforeEach(() => {
  customerTestEnv();
  vi.stubEnv("PAYMENT_MODE", "request_only");
  rate.rateLimit.mockResolvedValue(true);
});
afterAll(async () => {
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupWholesaleFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("price resolution matrix (account → price list → retail)", () => {
  it.each([
    ["no price list: retail price", null, 5, 50000, "retail"],
    ["below the first tier: retail", [[10, 40000], [100, 36000]], 9, 50000, "retail"],
    ["exactly at the first tier", [[10, 40000], [100, 36000]], 10, 40000, "list"],
    ["between tiers: the lower tier", [[10, 40000], [100, 36000]], 99, 40000, "list"],
    ["exactly at the top tier", [[10, 40000], [100, 36000]], 100, 36000, "list"],
    ["far above the top tier", [[10, 40000], [100, 36000]], 5000, 36000, "list"],
    ["single tier from 1", [[1, 45000]], 1, 45000, "list"],
  ] as const)("%s", async (_n, tiers, qty, expected, source) => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const list = tiers ? await createPriceList("m", [{ variantId: v.variantId, tiers: tiers.map(([minQty, unitPrice]) => ({ minQty, unitPrice })) }]) : null;
    const b = await makeBuyer({ priceListId: list?.id ?? null });
    const cart = await read(await bizCartValidate(mk("/api/business/cart/validate", b.cookie, { items: [{ variantId: v.variantId, quantity: qty }] })));
    expect(cart.body.lines[0]).toMatchObject({ unitPrice: expected, lineTotal: expected * qty, priceSource: source, available: true, problem: null });
    const r = await order(b.cookie, [{ variantId: v.variantId, quantity: qty }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await lines(r.body.order))[0]).toMatchObject({ unitPrice: expected, quantity: qty, lineTotal: expected * qty });
    const o = await db.order.findUniqueOrThrow({ where: { number: r.body.order.number } });
    expect(o).toMatchObject({ businessAccountId: b.account.id, customerId: b.customerId, paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation", paymentStatus: "unpaid", subtotal: expected * qty, total: expected * qty + o.deliveryFee });
  });

  it("a variant missing from the list, an inactive list, and another account's list all fall back to retail", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const other = await createInventoryVariant({ tracked: false, price: 30000 });
    const list = await createPriceList("partial", [{ variantId: other.variantId, tiers: [{ minQty: 1, unitPrice: 20000 }] }]);
    const b = await makeBuyer({ priceListId: list.id });
    expect((await lines((await order(b.cookie, [{ variantId: v.variantId, quantity: 3 }])).body.order))[0].unitPrice).toBe(50000); // not in the list
    expect((await lines((await order(b.cookie, [{ variantId: other.variantId, quantity: 3 }])).body.order))[0].unitPrice).toBe(20000);
    await db.priceList.update({ where: { id: list.id }, data: { active: false } });
    expect((await lines((await order(b.cookie, [{ variantId: other.variantId, quantity: 3 }])).body.order))[0].unitPrice).toBe(30000); // inactive list ignored
    const stranger = await makeBuyer({ priceListId: null });
    expect((await lines((await order(stranger.cookie, [{ variantId: other.variantId, quantity: 3 }])).body.order))[0].unitPrice).toBe(30000);
  });

  it("the client cannot set a price, a payment method or an account", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 50000 });
    const b = await makeBuyer();
    for (const extra of [{ unitPrice: 1 }, { paymentMethod: "razorpay" }, { businessAccountId: "x" }, { customerId: "x" }]) {
      expect((await bizOrder(mk("/api/business/orders", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 1 }], ...extra }))).status).toBe(422);
    }
    expect((await bizOrder(mk("/api/business/orders", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 1, unitPrice: 1 }] }))).status).toBe(422);
  });
});

describe("MOQ and case packs", () => {
  it("refuses a basket that breaks them with a 422 naming the item, and creates nothing", async () => {
    const v = await createInventoryVariant({ stock: 500 });
    await setTerms(v.variantId, 24, 12);
    const b = await makeBuyer();
    const below = await order(b.cookie, [{ variantId: v.variantId, quantity: 12 }]);
    expect(below).toMatchObject({ status: 422, body: { error: `${v.name} (250g): Minimum order is 24.` } });
    const off = await order(b.cookie, [{ variantId: v.variantId, quantity: 30 }]);
    expect(off).toMatchObject({ status: 422, body: { error: `${v.name} (250g): Order in multiples of 12 (case pack).` } });
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(0);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 0 }); // nothing held
    expect((await order(b.cookie, [{ variantId: v.variantId, quantity: 36 }])).status).toBe(201);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 36 });
  });

  it("cart validate reports the problem per line without refusing the call", async () => {
    const v = await createInventoryVariant({ tracked: false });
    await setTerms(v.variantId, 10, 5);
    const b = await makeBuyer();
    const r = await read(await bizCartValidate(mk("/api/business/cart/validate", b.cookie, { items: [{ variantId: v.variantId, quantity: 7 }, { variantId: "missing", quantity: 1 }] })));
    expect(r.status).toBe(200);
    expect(r.body.lines[0]).toMatchObject({ moq: 10, casePack: 5, problem: "Minimum order is 10" });
    expect(r.body.lines[1]).toMatchObject({ available: false, problem: "Item not found" });
  });

  it("retail checkout is never subject to MOQ, case packs or wholesale quantity limits", async () => {
    const v = await createInventoryVariant({ tracked: false });
    await setTerms(v.variantId, 100, 50);
    const retail = await read(await retailOrder(mk("/api/orders", undefined, { ...SHIPPING, paymentMethod: "cod", items: [{ variantId: v.variantId, quantity: 1 }] })));
    expect(retail.status).toBe(201);
    const over = await retailOrder(mk("/api/orders", undefined, { ...SHIPPING, paymentMethod: "cod", items: [{ variantId: v.variantId, quantity: 51 }] }));
    expect(over.status).toBe(422); // the retail 50-unit line cap is unchanged
    await db.order.deleteMany({ where: { number: retail.body.order.number } });
  });

  it("wholesale buyers can order in bulk (above the retail cap) and a tracked variant holds the units", async () => {
    const v = await createInventoryVariant({ stock: 5000, price: 50000 });
    const b = await makeBuyer();
    const r = await order(b.cookie, [{ variantId: v.variantId, quantity: 2500 }]);
    expect(r.status).toBe(201);
    expect((await lines(r.body.order))[0].quantity).toBe(2500);
    expect(await variantState(v.variantId)).toMatchObject({ stockQuantity: 5000, reserved: 2500 });
    const second = await order(b.cookie, [{ variantId: v.variantId, quantity: 3000 }]);
    expect(second).toMatchObject({ status: 409 });
    expect(second.body.error).toMatch(/Only 2500 of/);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 2500 }); // refused order left no hold
  });

  it("an unavailable or inactive product is refused like in retail", async () => {
    const off = await createInventoryVariant({ tracked: false, inStock: false });
    const hidden = await createInventoryVariant({ tracked: false, productActive: false });
    const b = await makeBuyer();
    expect((await order(b.cookie, [{ variantId: off.variantId, quantity: 1 }])).status).toBe(409);
    expect((await order(b.cookie, [{ variantId: hidden.variantId, quantity: 1 }])).status).toBe(409);
  });
});

describe("credit terms", () => {
  it("allows orders up to the limit, refuses beyond it, and frees exposure when an order is paid or cancelled", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10000 });
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 5_000_000 });
    const first = await order(b.cookie, [{ variantId: v.variantId, quantity: 400 }]); // 4,000,000 + delivery
    expect(first.status).toBe(201);
    const over = await order(b.cookie, [{ variantId: v.variantId, quantity: 200 }]);
    expect(over).toMatchObject({ status: 409 });
    expect(over.body.error).toMatch(/credit limit/);
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(1);
    // cancelling releases the exposure
    const o = await db.order.findUniqueOrThrow({ where: { number: first.body.order.number } });
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: { type: "admin", id: "t" }, reason: "buyer asked" });
    expect((await order(b.cookie, [{ variantId: v.variantId, quantity: 200 }])).status).toBe(201);
  });

  it("prepaid accounts have no credit limit check; credit with a zero limit buys nothing", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10000 });
    const prepaid = await makeBuyer({ paymentTerms: "prepaid", creditLimit: 0 });
    expect((await order(prepaid.cookie, [{ variantId: v.variantId, quantity: 300 }])).status).toBe(201);
    const zero = await makeBuyer({ paymentTerms: "credit", creditLimit: 0 });
    expect((await order(zero.cookie, [{ variantId: v.variantId, quantity: 1 }])).status).toBe(409);
  });

  it("parallel orders cannot jointly exceed the limit", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10000 });
    const b = await makeBuyer({ paymentTerms: "credit", creditLimit: 3_100_000 }); // room for 3 orders of 1,000,000 + delivery
    const results = await Promise.all(Array.from({ length: 8 }, () => order(b.cookie, [{ variantId: v.variantId, quantity: 100 }])));
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const total = (await db.order.aggregate({ where: { businessAccountId: b.account.id }, _sum: { total: true } }))._sum.total!;
    expect(total).toBeLessThanOrEqual(3_100_000);
  });
});

describe("idempotency and rate limiting on wholesale orders", () => {
  it("replays the first response for the same key and body; one order, one hold", async () => {
    const v = await createInventoryVariant({ stock: 100 });
    const b = await makeBuyer();
    const key = `biz-key-${Date.now()}-abcdefgh`;
    const first = await order(b.cookie, [{ variantId: v.variantId, quantity: 10 }], { "Idempotency-Key": key });
    const again = await bizOrder(mk("/api/business/orders", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 10 }] }, { "Idempotency-Key": key }));
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await read(again)).body).toEqual(first.body);
    expect(await db.order.count({ where: { businessAccountId: b.account.id } })).toBe(1);
    expect(await variantState(v.variantId)).toMatchObject({ reserved: 10 });
    expect((await bizOrder(mk("/api/business/orders", b.cookie, { ...SHIPPING, items: [{ variantId: v.variantId, quantity: 11 }] }, { "Idempotency-Key": key }))).status).toBe(422);
    // the same key from another account is a different key
    const other = await makeBuyer();
    expect((await order(other.cookie, [{ variantId: v.variantId, quantity: 10 }], { "Idempotency-Key": key })).status).toBe(201);
  });

  it("429 when rate limited; bad body 422; cross-origin 403", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const b = await makeBuyer();
    rate.rateLimit.mockResolvedValue(false);
    expect((await order(b.cookie, [{ variantId: v.variantId, quantity: 1 }])).status).toBe(429);
    rate.rateLimit.mockResolvedValue(true);
    expect((await bizOrder(mk("/api/business/orders", b.cookie, { ...SHIPPING, items: [] }))).status).toBe(422);
    expect((await order(b.cookie, [{ variantId: v.variantId, quantity: 1 }], { origin: "https://evil.example" })).status).toBe(403);
  });
});
