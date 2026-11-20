/**
 * M11 P3-T3 (F11): stock initialisation from a business-supplied count sheet. Parses strictly, plans without writing,
 * applies through the ledger, never goes below reserved units, is idempotent, and refuses a stale plan.
 */
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { applyStockImport, parseStockCsv, planStockImport } from "@/lib/inventory/import";
import { updateVariantInventory } from "@/lib/inventory/adjust";
import { cleanupFixtures } from "../support/mock-orders";
import { cleanupInventoryFixtures, createInventoryVariant, customer, movements, variantState } from "../support/inventory";

const ACTOR = { type: "system" as const, id: "inventory-import" };
const sku = (variantId: string) => db.variant.findUniqueOrThrow({ where: { id: variantId }, select: { sku: true } }).then((v) => v.sku);

afterAll(async () => {
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupInventoryFixtures();
  await cleanupFixtures();
  await db.$disconnect();
});

describe("parsing", () => {
  it("accepts sku,stock rows, skips blanks and comments, and rejects everything ambiguous", () => {
    expect(parseStockCsv("sku,stock\nA,5\n\n# note\nB,0\n")).toEqual({ rows: [{ line: 2, sku: "A", stock: 5 }, { line: 5, sku: "B", stock: 0 }], errors: [] });
    expect(parseStockCsv("code,qty\nA,1").errors[0]).toMatch(/header/);
    const bad = parseStockCsv("sku,stock\nA,-1\nB,2.5\nC,\n,4\nD,1,x\nE,3\nE,4\nF,200000");
    expect(bad.rows.map((r) => r.sku)).toEqual(["E"]);
    expect(bad.errors).toHaveLength(7);
    expect(parseStockCsv("sku,stock\n").errors).toEqual(["The file has no stock rows."]);
  });
});

describe("plan and apply", () => {
  it("starts tracking untracked variants with the counted stock, adjusts tracked ones, and re-running is a no-op", async () => {
    const untracked = await createInventoryVariant({ tracked: false });
    const tracked = await createInventoryVariant({ stock: 10 });
    const file = `sku,stock\n${await sku(untracked.variantId)},7\n${await sku(tracked.variantId)},4\n`;

    const plan = await planStockImport(parseStockCsv(file).rows);
    expect(plan.errors).toEqual([]);
    expect(plan.entries.map((e) => [e.action, e.current, e.delta])).toEqual([["start_tracking", null, 7], ["adjust", 10, -6]]);
    expect(await variantState(untracked.variantId)).toMatchObject({ trackInventory: false }); // planning writes nothing

    const r = await applyStockImport(plan, ACTOR, "Opening count");
    expect(r.every((x) => x.ok)).toBe(true);
    expect(await variantState(untracked.variantId)).toMatchObject({ trackInventory: true, stockQuantity: 7, inStock: true });
    expect(await variantState(tracked.variantId)).toMatchObject({ stockQuantity: 4 });
    expect((await movements(untracked.variantId)).at(-1)).toMatchObject({ actorType: "system", actorId: "inventory-import", note: "Opening count" });

    const again = await planStockImport(parseStockCsv(file).rows);
    expect(again.entries.map((e) => e.action)).toEqual(["unchanged", "unchanged"]);
    const before = (await movements(tracked.variantId)).length;
    await applyStockImport(again, ACTOR, "Opening count");
    expect(await movements(tracked.variantId)).toHaveLength(before);
  });

  it("an untracked variant counted at 0 becomes tracked and unavailable", async () => {
    const v = await createInventoryVariant({ tracked: false });
    await applyStockImport(await planStockImport(parseStockCsv(`sku,stock\n${await sku(v.variantId)},0`).rows), ACTOR, "Sold out at count");
    expect(await variantState(v.variantId)).toMatchObject({ trackInventory: true, stockQuantity: 0, inStock: false });
  });

  it("refuses a count below what open orders hold, and unknown SKUs, without changing anything", async () => {
    const v = await createInventoryVariant({ stock: 5 });
    await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: v.variantId, quantity: 3 }] });
    const plan = await planStockImport(parseStockCsv(`sku,stock\n${await sku(v.variantId)},2\nNO-SUCH-SKU-XYZ,1`).rows);
    expect(plan.errors).toHaveLength(2);
    expect(plan.errors.join(" ")).toMatch(/below the 3 unit\(s\) open orders hold/);
    await expect(applyStockImport(plan, ACTOR, "x count")).rejects.toThrow(/errors/);
    expect(await variantState(v.variantId)).toMatchObject({ stockQuantity: 5, reserved: 3 });
  });

  it("refuses a stale plan: stock that changed after planning is reported, never overwritten", async () => {
    const v = await createInventoryVariant({ stock: 10 });
    const plan = await planStockImport(parseStockCsv(`sku,stock\n${await sku(v.variantId)},8`).rows);
    expect((await updateVariantInventory({ variantId: v.variantId, actor: ACTOR, stockAdjust: { delta: 5, reason: "delivery arrived" } })).ok).toBe(true);
    const [r] = await applyStockImport(plan, ACTOR, "Recount");
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/changed since/);
    expect(await variantState(v.variantId)).toMatchObject({ stockQuantity: 15 });
  });

  it("lists active untracked variants that the file does not mention", async () => {
    const left = await createInventoryVariant({ tracked: false });
    const counted = await createInventoryVariant({ tracked: false });
    const plan = await planStockImport(parseStockCsv(`sku,stock\n${await sku(counted.variantId)},1`).rows);
    expect(plan.untrackedNotInFile).toContain(await sku(left.variantId));
    expect(plan.untrackedNotInFile).not.toContain(await sku(counted.variantId));
  });
});
