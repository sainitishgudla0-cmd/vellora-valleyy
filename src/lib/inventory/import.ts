import "server-only";
import { db } from "@/lib/db";
import { updateVariantInventory, MAX_STOCK_DELTA } from "./adjust";
import type { StockActor } from "./ledger";

/**
 * Stock initialisation from a count sheet supplied by the business (M11 P3-T3, finding F11). Nothing here invents a
 * quantity: every number comes from the file. Each row sets a variant's ABSOLUTE on-hand count by SKU:
 *  - an untracked variant is switched to tracking and receives the count as its opening stock;
 *  - a tracked variant is adjusted by the difference (never below what open orders hold);
 *  - a row equal to the current count is a no-op, so re-running the same file changes nothing.
 * Every change goes through `updateVariantInventory` (one transaction per row, ledger rows with the reason).
 */
export interface StockRow {
  line: number;
  sku: string;
  stock: number;
}

export type StockPlanAction = "start_tracking" | "adjust" | "unchanged";
export interface StockPlanEntry extends StockRow {
  variantId: string;
  action: StockPlanAction;
  current: number | null; // null = untracked (manual flag)
  reserved: number;
  delta: number;
}

export interface StockPlan {
  entries: StockPlanEntry[];
  errors: string[];
  /** active variants with tracking off that the file does not mention */
  untrackedNotInFile: string[];
}

export function parseStockCsv(text: string): { rows: StockRow[]; errors: string[] } {
  const rows: StockRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase());
  if (!header || header[0] !== "sku" || header[1] !== "stock") return { rows, errors: ['The first line must be the header "sku,stock".'] };
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const [skuRaw, stockRaw, ...rest] = raw.split(",").map((c) => c.trim());
    const line = i + 1;
    if (rest.some((c) => c !== "")) {
      errors.push(`line ${line}: expected 2 columns (sku,stock)`);
      continue;
    }
    if (!skuRaw) {
      errors.push(`line ${line}: missing sku`);
      continue;
    }
    if (!/^\d+$/.test(stockRaw ?? "")) {
      errors.push(`line ${line} (${skuRaw}): stock must be a whole number of units, 0 or more`);
      continue;
    }
    const stock = Number(stockRaw);
    if (stock > MAX_STOCK_DELTA) {
      errors.push(`line ${line} (${skuRaw}): ${stock} is above the ${MAX_STOCK_DELTA} limit for one change`);
      continue;
    }
    if (seen.has(skuRaw)) {
      errors.push(`line ${line}: sku ${skuRaw} appears more than once`);
      continue;
    }
    seen.add(skuRaw);
    rows.push({ line, sku: skuRaw, stock });
  }
  if (rows.length === 0 && errors.length === 0) errors.push("The file has no stock rows.");
  return { rows, errors };
}

export async function planStockImport(rows: StockRow[]): Promise<StockPlan> {
  const variants = await db.variant.findMany({ where: { sku: { in: rows.map((r) => r.sku) } }, select: { id: true, sku: true, trackInventory: true, stockQuantity: true, reserved: true } });
  const bySku = new Map(variants.map((v) => [v.sku, v]));
  const entries: StockPlanEntry[] = [];
  const errors: string[] = [];
  for (const r of rows) {
    const v = bySku.get(r.sku);
    if (!v) {
      errors.push(`line ${r.line}: unknown sku ${r.sku}`);
      continue;
    }
    if (v.trackInventory && r.stock < v.reserved) {
      errors.push(`line ${r.line} (${r.sku}): ${r.stock} is below the ${v.reserved} unit(s) open orders hold`);
      continue;
    }
    const current = v.trackInventory ? v.stockQuantity : null;
    const action: StockPlanAction = !v.trackInventory ? "start_tracking" : r.stock === v.stockQuantity ? "unchanged" : "adjust";
    entries.push({ ...r, variantId: v.id, action, current, reserved: v.reserved, delta: r.stock - (current ?? 0) });
  }
  const untracked = await db.variant.findMany({ where: { trackInventory: false, product: { active: true }, sku: { notIn: rows.map((r) => r.sku) } }, select: { sku: true }, orderBy: { sku: "asc" } });
  return { entries, errors, untrackedNotInFile: untracked.map((u) => u.sku) };
}

export interface StockApplyResult {
  sku: string;
  action: StockPlanAction;
  ok: boolean;
  stockAfter?: number;
  error?: string;
}

/** Applies a plan with no errors. Each row is its own transaction; a refused row (e.g. stock reserved meanwhile) is reported, never forced. */
export async function applyStockImport(plan: StockPlan, actor: StockActor, reason: string): Promise<StockApplyResult[]> {
  if (plan.errors.length) throw new Error("Refusing to apply a plan with errors");
  const note = reason.trim();
  if (note.length < 3) throw new Error("A reason (3+ characters) is required");
  const out: StockApplyResult[] = [];
  for (const e of plan.entries) {
    if (e.action === "unchanged") {
      out.push({ sku: e.sku, action: e.action, ok: true, stockAfter: e.stock });
      continue;
    }
    const r =
      e.action === "start_tracking"
        ? await updateVariantInventory({ variantId: e.variantId, actor, trackInventory: true, reason: note, expectStockQuantity: 0, ...(e.stock > 0 ? { stockAdjust: { delta: e.stock, reason: note } } : {}) })
        : await updateVariantInventory({ variantId: e.variantId, actor, stockAdjust: { delta: e.delta, reason: note }, expectStockQuantity: e.current! });
    out.push(r.ok ? { sku: e.sku, action: e.action, ok: true, stockAfter: r.stockQuantity } : { sku: e.sku, action: e.action, ok: false, error: r.message });
  }
  return out;
}
