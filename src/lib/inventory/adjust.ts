import "server-only";
import { db } from "@/lib/db";
import { availableUnits } from "./availability";
import { applyStockChange, type StockActor } from "./ledger";

export type AdjustCode = "not_found" | "not_tracked" | "negative_stock" | "below_reserved" | "reserved_open";
export type AdjustResult =
  | { ok: true; trackInventory: boolean; stockQuantity: number; reserved: number; available: number | null }
  | { ok: false; code: AdjustCode; message: string };

export const MAX_STOCK_DELTA = 100_000;

const fail = (code: AdjustCode, message: string): AdjustResult => ({ ok: false, code, message });
class Abort extends Error {
  constructor(public result: AdjustResult) {
    super(result.ok ? "ok" : result.code);
  }
}

export interface VariantInventoryUpdate {
  variantId: string;
  actor: StockActor;
  /** true = start counting units (opening stock comes from `stockAdjust`); false = back to the manual flag. */
  trackInventory?: boolean;
  /** Required when `trackInventory` is given. Recorded on the ledger row that zeroes stock when tracking is switched off. */
  reason?: string;
  stockAdjust?: { delta: number; reason: string };
}

/**
 * Staff stock changes (M3-T6): enabling/disabling tracking and signed adjustments, all through the ledger and
 * atomic (a failed part rolls everything back). Cannot take stock below zero or below what open orders hold.
 */
export async function updateVariantInventory(input: VariantInventoryUpdate): Promise<AdjustResult> {
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.variant.findUnique({ where: { id: input.variantId }, select: { trackInventory: true } });
      if (!current) throw new Abort(fail("not_found", "Variant not found"));

      if (input.trackInventory === true && !current.trackInventory) {
        await tx.variant.updateMany({ where: { id: input.variantId, trackInventory: false }, data: { trackInventory: true, inStock: false } }); // untracked variants hold no counts, so this starts at zero units
      }
      if (input.stockAdjust) {
        const { delta, reason } = input.stockAdjust;
        const r = await applyStockChange(tx, { variantId: input.variantId, reason: "adjustment", stockDelta: delta, reservedDelta: 0, note: reason, actor: input.actor });
        if (!r) {
          const v = await tx.variant.findUniqueOrThrow({ where: { id: input.variantId }, select: { trackInventory: true, stockQuantity: true } });
          if (!v.trackInventory) throw new Abort(fail("not_tracked", "Turn on inventory tracking for this variant before adjusting stock"));
          if (v.stockQuantity + delta < 0) throw new Abort(fail("negative_stock", "Stock cannot go below zero"));
          throw new Abort(fail("below_reserved", "Stock cannot go below the units reserved for open orders"));
        }
      }
      if (input.trackInventory === false && current.trackInventory) {
        const v = await tx.variant.findUniqueOrThrow({ where: { id: input.variantId }, select: { stockQuantity: true, reserved: true } });
        if (v.reserved > 0) throw new Abort(fail("reserved_open", "Open orders still hold units of this variant"));
        if (v.stockQuantity > 0) {
          const z = await applyStockChange(tx, { variantId: input.variantId, reason: "adjustment", stockDelta: -v.stockQuantity, reservedDelta: 0, note: `Inventory tracking switched off: ${input.reason ?? "no reason given"}`, actor: input.actor });
          if (!z) throw new Abort(fail("reserved_open", "Open orders still hold units of this variant"));
        }
        const off = await tx.variant.updateMany({ where: { id: input.variantId, trackInventory: true, reserved: 0, stockQuantity: 0 }, data: { trackInventory: false } });
        if (off.count !== 1) throw new Abort(fail("reserved_open", "Open orders still hold units of this variant"));
      }
      const after = await tx.variant.findUniqueOrThrow({ where: { id: input.variantId }, select: { trackInventory: true, stockQuantity: true, reserved: true } });
      return { ok: true as const, ...after, available: availableUnits(after) };
    });
  } catch (e) {
    if (e instanceof Abort) return e.result;
    throw e;
  }
}

export interface LowStockRow {
  variantId: string;
  sku: string;
  product: string;
  label: string;
  stockQuantity: number;
  reserved: number;
  available: number;
}

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** Tracked variants with at most `threshold` sellable units, lowest first. */
export async function listLowStock(threshold = DEFAULT_LOW_STOCK_THRESHOLD): Promise<LowStockRow[]> {
  const rows = await db.variant.findMany({
    where: { trackInventory: true, product: { active: true } },
    select: { id: true, sku: true, label: true, stockQuantity: true, reserved: true, product: { select: { name: true } } },
  });
  return rows
    .map((v) => ({ variantId: v.id, sku: v.sku, product: v.product.name, label: v.label, stockQuantity: v.stockQuantity, reserved: v.reserved, available: Math.max(0, v.stockQuantity - v.reserved) }))
    .filter((r) => r.available <= threshold)
    .sort((a, b) => a.available - b.available || a.sku.localeCompare(b.sku));
}
