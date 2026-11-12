/** M3-T1/T6: admin variant PATCH + low-stock routes, and the derived inStock in the public catalogue and cart check. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { toView } from "@/lib/catalog";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupInventoryFixtures, createInventoryVariant, customer, movements, variantState } from "../support/inventory";

import { PATCH } from "@/app/api/admin/variants/[id]/route";
import { GET as lowStock } from "@/app/api/admin/variants/low-stock/route";
import { DELETE as removeTestData } from "@/app/api/admin/test-data/route";
import { POST as cartValidate } from "@/app/api/cart/validate/route";

let admin: Awaited<ReturnType<typeof createTestAdmin>>;
let cookie: string | undefined;
const patch = async (id: string, body: unknown) => {
  const res = await PATCH(new Request("http://localhost/api/admin/variants/x", { method: "PATCH", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const low = async (qs = "") => {
  const res = await lowStock(new Request(`http://localhost/api/admin/variants/low-stock${qs}`, { headers: cookie ? { cookie } : {} }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(async () => {
  admin ??= await createTestAdmin("owner");
  cookie = admin.cookie;
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "request_only");
});
afterAll(async () => {
  await cleanupAdminFixtures();
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("PATCH /api/admin/variants/[id]", () => {
  it("requires an admin", async () => {
    cookie = undefined;
    const t = await createInventoryVariant({ stock: 1 });
    expect((await patch(t.variantId, { stockAdjust: { delta: 1, reason: "x y z" } })).status).toBe(401);
    expect((await low()).status).toBe(401);
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 1 });
  });

  it("keeps the dashboard's price + inStock payload working for untracked variants (response only gains fields)", async () => {
    const u = await createInventoryVariant({ tracked: false });
    const r = await patch(u.variantId, { price: 123.5, inStock: false });
    expect(r).toMatchObject({ status: 200, body: { ok: true, price: 12350, inStock: false, trackInventory: false } });
    expect(await variantState(u.variantId)).toMatchObject({ inStock: false });
  });

  it("for tracked variants the dashboard payload changes the price but counts keep deciding availability", async () => {
    const t = await createInventoryVariant({ stock: 4 });
    const r = await patch(t.variantId, { price: 99, inStock: false }); // what the unchanged dashboard sends
    expect(r).toMatchObject({ status: 200, body: { price: 9900, inStock: true, trackInventory: true, stockQuantity: 4, reserved: 0, available: 4 } });
    expect(await variantState(t.variantId)).toMatchObject({ inStock: true });
  });

  it("turns tracking on with opening stock, adjusts, and refuses bad changes with 409 codes", async () => {
    const u = await createInventoryVariant({ tracked: false });
    expect((await patch(u.variantId, { stockAdjust: { delta: 5, reason: "Opening" } })).body).toMatchObject({ code: "not_tracked" });
    const on = await patch(u.variantId, { trackInventory: true, reason: "Start counting", stockAdjust: { delta: 20, reason: "Opening stock count" } });
    expect(on).toMatchObject({ status: 200, body: { trackInventory: true, stockQuantity: 20, available: 20 } });
    expect(await patch(u.variantId, { stockAdjust: { delta: -3, reason: "Damaged in storage" } })).toMatchObject({ status: 200, body: { stockQuantity: 17 } });
    expect(await patch(u.variantId, { stockAdjust: { delta: -18, reason: "Recount error" } })).toMatchObject({ status: 409, body: { code: "negative_stock" } });
    expect(await variantState(u.variantId)).toMatchObject({ stockQuantity: 17 });
    expect((await movements(u.variantId)).map((m) => [m.stockDelta, m.note, m.actorType, m.actorId])).toEqual([[20, "Opening stock count", "admin", admin.user.id], [-3, "Damaged in storage", "admin", admin.user.id]]);
  });

  it("validates input: delta must be a non-zero whole number, reasons are required, tracking changes need a reason", async () => {
    const t = await createInventoryVariant({ stock: 2 });
    for (const body of [
      { stockAdjust: { delta: 0, reason: "nothing" } },
      { stockAdjust: { delta: 1.5, reason: "fraction" } },
      { stockAdjust: { delta: 1, reason: "no" } },
      { stockAdjust: { delta: 1 } },
      { stockAdjust: { delta: 1_000_000, reason: "too many" } },
      { trackInventory: false },
    ]) expect((await patch(t.variantId, body)).status).toBe(422);
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 2, trackInventory: true });
  });

  it("404 for an unknown variant", async () => {
    expect((await patch("missing", { stockAdjust: { delta: 1, reason: "whatever" } })).status).toBe(404);
    expect((await patch("missing", { price: 10 })).status).toBe(404);
  });

  it("will not switch tracking off while open orders hold units", async () => {
    const t = await createInventoryVariant({ stock: 3 });
    await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] });
    expect(await patch(t.variantId, { trackInventory: false, reason: "Back to manual" })).toMatchObject({ status: 409, body: { code: "reserved_open" } });
  });
});

describe("GET /api/admin/variants/low-stock", () => {
  it("lists tracked variants at or below the threshold and validates the threshold", async () => {
    const a = await createInventoryVariant({ stock: 3 });
    const b = await createInventoryVariant({ stock: 30 });
    const r = await low("?threshold=5");
    expect(r.status).toBe(200);
    const ids = r.body.variants.map((v: { variantId: string }) => v.variantId);
    expect(ids).toContain(a.variantId);
    expect(ids).not.toContain(b.variantId);
    expect(r.body.threshold).toBe(5);
    expect((await low("?threshold=100")).body.variants.map((v: { variantId: string }) => v.variantId)).toContain(b.variantId);
    expect((await low("?threshold=-1")).status).toBe(422);
    expect((await low("?threshold=abc")).status).toBe(422);
    expect((await low()).body.threshold).toBe(5);
  });
});

describe("public availability is derived for tracked variants", () => {
  it("catalogue view and cart check follow units available, never expose counts", async () => {
    const t = await createInventoryVariant({ stock: 1 });
    const view = async () => toView((await db.product.findUniqueOrThrow({ where: { id: t.product.id }, include: { variants: true } })));
    expect((await view()).variants[0]).toMatchObject({ inStock: true });
    expect(Object.keys((await view()).variants[0])).not.toContain("stockQuantity");
    const cart = async () => (await (await cartValidate(new Request("http://localhost/api/cart/validate", { method: "POST", body: JSON.stringify({ variantIds: [t.variantId] }) }))).json()).variants[0];
    expect(await cart()).toMatchObject({ available: true });
    await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] });
    expect((await view()).variants[0].inStock).toBe(false);
    expect(await cart()).toMatchObject({ available: false });
    expect(Object.keys(await cart()).sort()).toEqual(["available", "id", "mrp", "price"]);
  });

  it("untracked variants still follow the manual flag", async () => {
    const u = await createInventoryVariant({ tracked: false, inStock: false });
    const p = await db.product.findUniqueOrThrow({ where: { id: u.product.id }, include: { variants: true } });
    expect(toView(p).variants[0].inStock).toBe(false);
  });
});

describe("test-data cleanup releases held stock", () => {
  it("DELETE /api/admin/test-data returns the units held by the test orders it removes", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 3 }] });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 3 });
    const res = await removeTestData(new Request("http://localhost/api/admin/test-data", { method: "DELETE", headers: { cookie: admin.cookie } }));
    expect(res.status).toBe(200);
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 5, reserved: 0 });
    expect((await movements(t.variantId)).at(-1)).toMatchObject({ reason: "release", reservedDelta: -3, orderId: null }); // the order row is gone; the ledger row stays (order link set null)
    expect(await findLedgerDrift()).toEqual([]);
  });
});
