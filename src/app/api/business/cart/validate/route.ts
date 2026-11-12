import { db } from "@/lib/db";
import { json, parseBody } from "@/lib/api";
import { effectiveInStock } from "@/lib/inventory/availability";
import { requireBusiness } from "@/lib/wholesale/auth";
import { loadQuantityTerms, loadTiers } from "@/lib/wholesale/pricing";
import { NO_RESTRICTION, quantityProblem, resolveUnitPrice } from "@/lib/wholesale/rules";
import { businessCartSchema } from "@/lib/wholesale/schemas";

/** Prices and rules for a wholesale basket (the buyer's tiers, MOQ, case pack). Retail `POST /api/cart/validate` is unchanged and never shows these. */
export async function POST(req: Request) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, businessCartSchema);
  if ("response" in parsed) return parsed.response;
  const qty = new Map<string, number>();
  for (const i of parsed.data.items) qty.set(i.variantId, (qty.get(i.variantId) ?? 0) + i.quantity);
  const ids = [...qty.keys()];
  const [variants, terms, tiers] = await Promise.all([
    db.variant.findMany({ where: { id: { in: ids } }, include: { product: { select: { active: true, name: true } } } }),
    loadQuantityTerms(db, ids),
    loadTiers(db, auth.account.priceListId, ids),
  ]);
  const by = new Map(variants.map((v) => [v.id, v]));
  const lines = ids.map((id) => {
    const v = by.get(id);
    const quantity = qty.get(id)!;
    if (!v) return { variantId: id, quantity, available: false, problem: "Item not found" };
    const t = terms.get(id) ?? NO_RESTRICTION;
    const { unitPrice, source } = resolveUnitPrice(v.price, tiers.get(id) ?? [], quantity);
    return { variantId: id, quantity, available: v.product.active && effectiveInStock(v), unitPrice, lineTotal: unitPrice * quantity, priceSource: source, moq: t.moq, casePack: t.casePack, problem: quantityProblem(t, quantity) };
  });
  return json({ lines, subtotal: lines.reduce((s, l) => s + ((l as { lineTotal?: number }).lineTotal ?? 0), 0) });
}
