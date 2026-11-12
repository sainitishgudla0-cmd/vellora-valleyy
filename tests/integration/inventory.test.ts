/** M3-T1/T2/T3/T6: stock, reservations, ledger and DB constraints against a real (disposable) Postgres. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder, OrderError } from "@/lib/orders";
import { transitionOrder } from "@/lib/orders/state-machine";
import { listLowStock, updateVariantInventory } from "@/lib/inventory/adjust";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { cleanupInventoryFixtures, createInventoryVariant, customer, movements, variantState } from "../support/inventory";

const ADMIN = { type: "admin" as const, id: "admin" };
const SYSTEM = { type: "system" as const, id: "test" };
const order = (items: { variantId: string; quantity: number }[]) => createOrder({ ...customer, paymentMethod: "cod", items });

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "request_only");
});
afterAll(async () => {
  expect(await findLedgerDrift()).toEqual([]); // whatever the tests did, counters still equal the ledger
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("database constraints (the backstop under the application checks)", () => {
  it("rejects negative stock, over-reservation, counts on untracked variants and malformed ledger rows", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const u = await createInventoryVariant({ tracked: false });
    await expect(db.variant.update({ where: { id: t.variantId }, data: { stockQuantity: -1 } })).rejects.toThrow(/Variant_inventory_counts_check/);
    await expect(db.variant.update({ where: { id: t.variantId }, data: { reserved: 6 } })).rejects.toThrow(/Variant_inventory_counts_check/);
    await expect(db.variant.update({ where: { id: u.variantId }, data: { stockQuantity: 1 } })).rejects.toThrow(/Variant_inventory_counts_check/);
    const row = { variantId: t.variantId, actorType: "admin" as const, stockAfter: 5, reservedAfter: 0 };
    await expect(db.inventoryMovement.create({ data: { ...row, reason: "adjustment", stockDelta: 1, reservedDelta: 0 } })).rejects.toThrow(/InventoryMovement_shape_check/); // note required
    await expect(db.inventoryMovement.create({ data: { ...row, reason: "reserve", stockDelta: 1, reservedDelta: 1 } })).rejects.toThrow(/InventoryMovement_shape_check/);
    await expect(db.inventoryMovement.create({ data: { ...row, reason: "fulfil", stockDelta: -1, reservedDelta: -2 } })).rejects.toThrow(/InventoryMovement_shape_check/);
    await expect(db.inventoryMovement.create({ data: { ...row, reason: "release", stockDelta: 0, reservedDelta: 1 } })).rejects.toThrow(/InventoryMovement_shape_check/);
  });
});

describe("admin stock changes (M3-T6)", () => {
  it("enabling tracking starts at zero units (out of stock) and opening stock goes through the ledger", async () => {
    const v = await createInventoryVariant({ tracked: false, inStock: true });
    const r = await updateVariantInventory({ variantId: v.variantId, actor: ADMIN, trackInventory: true, reason: "Start counting" });
    expect(r).toMatchObject({ ok: true, trackInventory: true, stockQuantity: 0, available: 0 });
    expect(await variantState(v.variantId)).toMatchObject({ inStock: false });
    const a = await updateVariantInventory({ variantId: v.variantId, actor: ADMIN, stockAdjust: { delta: 12, reason: "Opening stock count" } });
    expect(a).toMatchObject({ ok: true, stockQuantity: 12, available: 12 });
    expect(await variantState(v.variantId)).toMatchObject({ inStock: true });
    expect(await movements(v.variantId)).toMatchObject([{ reason: "adjustment", stockDelta: 12, reservedDelta: 0, stockAfter: 12, reservedAfter: 0, note: "Opening stock count", actorType: "admin", actorId: "admin" }]);
  });

  it("refuses adjustments on untracked variants, below zero, and below the units open orders hold", async () => {
    const u = await createInventoryVariant({ tracked: false });
    expect(await updateVariantInventory({ variantId: u.variantId, actor: ADMIN, stockAdjust: { delta: 5, reason: "nope" } })).toMatchObject({ ok: false, code: "not_tracked" });
    const t = await createInventoryVariant({ stock: 5 });
    expect(await updateVariantInventory({ variantId: t.variantId, actor: ADMIN, stockAdjust: { delta: -6, reason: "Recount" } })).toMatchObject({ ok: false, code: "negative_stock" });
    await order([{ variantId: t.variantId, quantity: 4 }]);
    expect(await updateVariantInventory({ variantId: t.variantId, actor: ADMIN, stockAdjust: { delta: -2, reason: "Damaged" } })).toMatchObject({ ok: false, code: "below_reserved" });
    expect(await updateVariantInventory({ variantId: t.variantId, actor: ADMIN, stockAdjust: { delta: -1, reason: "Damaged" } })).toMatchObject({ ok: true, stockQuantity: 4, reserved: 4, available: 0 });
    expect(await updateVariantInventory({ variantId: "missing", actor: ADMIN, stockAdjust: { delta: 1, reason: "x" } })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("a failed part rolls the whole update back", async () => {
    const t = await createInventoryVariant({ stock: 3 });
    const r = await updateVariantInventory({ variantId: t.variantId, actor: ADMIN, trackInventory: false, reason: "x", stockAdjust: { delta: -9, reason: "too much" } });
    expect(r).toMatchObject({ ok: false, code: "negative_stock" });
    expect(await variantState(t.variantId)).toMatchObject({ trackInventory: true, stockQuantity: 3 });
  });

  it("switching tracking off zeroes stock through the ledger, but not while open orders hold units", async () => {
    const t = await createInventoryVariant({ stock: 6 });
    await order([{ variantId: t.variantId, quantity: 1 }]);
    expect(await updateVariantInventory({ variantId: t.variantId, actor: ADMIN, trackInventory: false, reason: "Back to manual" })).toMatchObject({ ok: false, code: "reserved_open" });
    const free = await createInventoryVariant({ stock: 6 });
    expect(await updateVariantInventory({ variantId: free.variantId, actor: ADMIN, trackInventory: false, reason: "Back to manual" })).toMatchObject({ ok: true, trackInventory: false, stockQuantity: 0, available: null });
    const last = (await movements(free.variantId)).at(-1)!;
    expect(last).toMatchObject({ reason: "adjustment", stockDelta: -6, stockAfter: 0 });
    expect(last.note).toContain("Back to manual");
    expect(await findLedgerDrift()).toEqual([]);
  });

  it("lists tracked variants at or below the threshold, lowest first, counting only sellable units", async () => {
    const low = await createInventoryVariant({ stock: 2 });
    const out = await createInventoryVariant({ stock: 1 });
    const fine = await createInventoryVariant({ stock: 50 });
    await createInventoryVariant({ tracked: false });
    await order([{ variantId: out.variantId, quantity: 1 }]);
    const ids = (await listLowStock(5)).map((r) => r.variantId);
    expect(ids).toContain(low.variantId);
    expect(ids).toContain(out.variantId);
    expect(ids).not.toContain(fine.variantId);
    expect(ids.indexOf(out.variantId)).toBeLessThan(ids.indexOf(low.variantId));
    expect((await listLowStock(5)).find((r) => r.variantId === out.variantId)).toMatchObject({ stockQuantity: 1, reserved: 1, available: 0 });
  });
});

describe("reservation at order creation (M3-T2)", () => {
  it("holds the ordered units, records a reserve movement and derives inStock", async () => {
    const t = await createInventoryVariant({ stock: 10 });
    const o = await order([{ variantId: t.variantId, quantity: 3 }]);
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 10, reserved: 3, inStock: true });
    const m = (await movements(t.variantId)).at(-1)!;
    expect(m).toMatchObject({ reason: "reserve", stockDelta: 0, reservedDelta: 3, reservedAfter: 3, orderId: o.id, actorType: "customer" });
    await order([{ variantId: t.variantId, quantity: 7 }]);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 10, inStock: false }); // nothing left to sell
  });

  it("refuses with 409 naming the item, and says how many are left", async () => {
    const t = await createInventoryVariant({ stock: 2 });
    await expect(order([{ variantId: t.variantId, quantity: 3 }])).rejects.toMatchObject({ status: 409, message: `Only 2 of ${t.name} (250g) left in stock. Please reduce the quantity.` });
    await order([{ variantId: t.variantId, quantity: 2 }]);
    await expect(order([{ variantId: t.variantId, quantity: 1 }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${t.name} (250g) is`) });
    expect(await db.order.count({ where: { customerName: customer.customerName, items: { some: { variantId: t.variantId } } } })).toBe(1);
  });

  it("is all-or-nothing across lines: a refused line leaves no hold and no order behind", async () => {
    const a = await createInventoryVariant({ stock: 5 });
    const b = await createInventoryVariant({ stock: 1 });
    await expect(order([{ variantId: a.variantId, quantity: 2 }, { variantId: b.variantId, quantity: 2 }])).rejects.toBeInstanceOf(OrderError);
    expect(await variantState(a.variantId)).toMatchObject({ reserved: 0 });
    expect(await variantState(b.variantId)).toMatchObject({ reserved: 0 });
    expect(await db.order.count({ where: { items: { some: { variantId: { in: [a.variantId, b.variantId] } } } } })).toBe(0);
    expect(await movements(a.variantId)).toHaveLength(1); // only the opening stock
  });

  it("does not touch variants that are not tracked: the manual flag still decides, no movements", async () => {
    const u = await createInventoryVariant({ tracked: false });
    await order([{ variantId: u.variantId, quantity: 4 }]);
    expect(await variantState(u.variantId)).toMatchObject({ stockQuantity: 0, reserved: 0 });
    expect(await movements(u.variantId)).toHaveLength(0);
    const off = await createInventoryVariant({ tracked: false, inStock: false });
    await expect(order([{ variantId: off.variantId, quantity: 1 }])).rejects.toMatchObject({ status: 409 });
  });

  it("a tracked variant ignores a stale manual flag", async () => {
    const t = await createInventoryVariant({ stock: 3 });
    await db.variant.update({ where: { id: t.variantId }, data: { inStock: false } }); // legacy flag says out of stock
    await expect(order([{ variantId: t.variantId, quantity: 1 }])).resolves.toBeTruthy(); // counts are authoritative
  });

  it("N parallel orders for the last unit: exactly one wins (repeated 20 times)", async () => {
    for (let round = 0; round < 20; round++) {
      const t = await createInventoryVariant({ stock: 1 });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => order([{ variantId: t.variantId, quantity: 1 }])));
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(5);
      expect(refused.every((r) => r.reason instanceof OrderError && r.reason.status === 409)).toBe(true);
      expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 1, reserved: 1 });
    }
  }, 120_000);

  it("never oversells with mixed quantities, and orders over the same variants in opposite line order do not deadlock", async () => {
    const a = await createInventoryVariant({ stock: 7 });
    const b = await createInventoryVariant({ stock: 7 });
    const lines = (flip: boolean, q: number) => (flip ? [{ variantId: b.variantId, quantity: q }, { variantId: a.variantId, quantity: q }] : [{ variantId: a.variantId, quantity: q }, { variantId: b.variantId, quantity: q }]);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => order(lines(i % 2 === 0, (i % 3) + 1))));
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused.every((r) => r.reason instanceof OrderError && r.reason.status === 409)).toBe(true); // no deadlock / serialization errors
    const sa = await variantState(a.variantId);
    const sb = await variantState(b.variantId);
    expect(sa.reserved).toBeLessThanOrEqual(7);
    expect(sa.reserved).toBe(sb.reserved); // every successful order took the same quantity from both
    const sold = results.filter((r) => r.status === "fulfilled").length;
    expect(sold).toBeGreaterThan(0);
    expect(sold).toBeLessThan(12);
  });
});

describe("release and fulfilment follow the order status (M3-T3)", () => {
  const place = async (stock: number, qty: number) => {
    const t = await createInventoryVariant({ stock });
    const o = await order([{ variantId: t.variantId, quantity: qty }]);
    return { t, o };
  };

  it("cancelling releases the hold exactly once", async () => {
    const { t, o } = await place(5, 3);
    const r = await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "Customer asked" });
    expect(r.ok).toBe(true);
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 5, reserved: 0, inStock: true });
    expect((await movements(t.variantId)).at(-1)).toMatchObject({ reason: "release", stockDelta: 0, reservedDelta: -3, orderId: o.id });
    const again = await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "again" });
    expect(again).toMatchObject({ ok: false, code: "stale_state" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 });
    expect((await movements(t.variantId)).filter((m) => m.reason === "release")).toHaveLength(1);
  });

  it("dispatch consumes the hold; cancelling after dispatch does not put units back", async () => {
    const { t, o } = await place(5, 2);
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "ok" });
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 5, reserved: 2 });
    await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN, reason: "shipped" });
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 3, reserved: 0 });
    expect((await movements(t.variantId)).at(-1)).toMatchObject({ reason: "fulfil", stockDelta: -2, reservedDelta: -2 });
    await transitionOrder({ orderId: o.id, from: "dispatched", to: "cancelled", actor: ADMIN, reason: "lost in transit" });
    expect(await variantState(t.variantId)).toMatchObject({ stockQuantity: 3, reserved: 0 }); // returned goods are restocked by hand
  });

  it("a cancelled order frees the units for the next customer", async () => {
    const { t, o } = await place(1, 1);
    await expect(order([{ variantId: t.variantId, quantity: 1 }])).rejects.toBeInstanceOf(OrderError);
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "gone" });
    await expect(order([{ variantId: t.variantId, quantity: 1 }])).resolves.toBeTruthy();
  });

  it("orders that hold nothing (untracked variant, or created before tracking) release and fulfil nothing", async () => {
    const u = await createInventoryVariant({ tracked: false });
    const o = await order([{ variantId: u.variantId, quantity: 2 }]);
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "ok" });
    await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN, reason: "ok" });
    expect(await movements(u.variantId)).toHaveLength(0);
    // an order placed while the variant was untracked, dispatched after tracking was turned on: no phantom deduction
    const v = await createInventoryVariant({ tracked: false });
    const early = await order([{ variantId: v.variantId, quantity: 2 }]);
    await updateVariantInventory({ variantId: v.variantId, actor: ADMIN, trackInventory: true, reason: "go", stockAdjust: { delta: 10, reason: "Opening" } });
    await transitionOrder({ orderId: early.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "x" });
    expect(await variantState(v.variantId)).toMatchObject({ stockQuantity: 10, reserved: 0 });
  });

  it("an interrupted transition leaves stock and status untouched (atomic with the order change)", async () => {
    const { t, o } = await place(4, 2);
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION m3_fail_release() RETURNS trigger AS $$ BEGIN IF NEW."reason" = 'release' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER m3_fail_release BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION m3_fail_release()`);
    try {
      await expect(transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "x" })).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER m3_fail_release ON "InventoryMovement"`);
      await db.$executeRawUnsafe(`DROP FUNCTION m3_fail_release()`);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("pending_confirmation");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("system actors (expiry, gateway) release too, and the ledger always sums to the counters", async () => {
    const { t, o } = await place(9, 4);
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: SYSTEM, reason: "automatic" });
    expect((await movements(t.variantId)).at(-1)).toMatchObject({ reason: "release", actorType: "system", actorId: "test" });
    expect(await findLedgerDrift()).toEqual([]);
  });
});
