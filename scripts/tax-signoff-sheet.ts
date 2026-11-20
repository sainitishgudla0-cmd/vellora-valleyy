/**
 * Operator tool (M11 P3-T6, finding F14): the GST sign-off sheet for the accountant, read-only.
 *   npm run tax:signoff-sheet > gst-signoff.csv
 * One row per HSN code used by an active product variant (plus DELIVERY), with the products/packs using it and the rate
 * currently recorded (if any). The accountant fills `approved_rate_percent`, `effective_from` and `approved_by`; an owner
 * then enters each approved row under Admin → Settings → GST rates (or POST /api/admin/tax-rates). This script never
 * suggests a rate.
 */
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
const csv = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const { db } = await import("../src/lib/db");
  const variants = await db.variant.findMany({ where: { product: { active: true } }, select: { hsCode: true, sku: true, label: true, product: { select: { name: true } } }, orderBy: { sku: "asc" } });
  const rates = await db.taxRate.findMany({ orderBy: { effectiveFrom: "desc" } });
  const byCode = new Map<string, { products: Set<string>; skus: string[] }>();
  for (const v of variants) {
    const e = byCode.get(v.hsCode) ?? { products: new Set<string>(), skus: [] };
    e.products.add(v.product.name);
    e.skus.push(`${v.sku} (${v.label})`);
    byCode.set(v.hsCode, e);
  }
  byCode.set("DELIVERY", byCode.get("DELIVERY") ?? { products: new Set(["Delivery charge (when a fee applies)"]), skus: [] });
  const now = new Date();
  console.log("hsn_code,products,packs,recorded_rate_percent,recorded_from,approved_rate_percent,effective_from,approved_by");
  for (const [code, e] of [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = rates.find((r) => r.code === code && r.effectiveFrom <= now);
    console.log([code, [...e.products].join("; "), e.skus.join("; "), current ? (current.rateBp / 100).toFixed(2) : "", current ? current.effectiveFrom.toISOString().slice(0, 10) : "", "", "", ""].map(csv).join(","));
  }
  console.error(`[tax] ${byCode.size} code(s), ${variants.length} active pack(s); rows without a recorded rate block invoicing for those items.`);
  await db.$disconnect();
}
main().catch((e) => {
  console.error(`[tax] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
