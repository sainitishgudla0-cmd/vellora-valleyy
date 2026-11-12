import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { requireBusiness } from "@/lib/wholesale/auth";

export const dynamic = "force-dynamic";

/**
 * The approved buyer's own wholesale prices: the tiers of THEIR price list plus MOQ / case pack, per variant. Retail
 * endpoints never carry these, and another account's list is unreachable (the list id comes from the account, not the request).
 */
export async function GET(req: Request) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  const { account } = auth;
  const [items, terms] = await Promise.all([
    account.priceListId
      ? db.priceListItem.findMany({ where: { priceListId: account.priceListId, priceList: { active: true } }, orderBy: [{ variantId: "asc" }, { minQty: "asc" }], include: { variant: { select: { id: true, sku: true, label: true, price: true, product: { select: { name: true } } } } } })
      : Promise.resolve([]),
    db.variantWholesale.findMany(),
  ]);
  const t = new Map(terms.map((x) => [x.variantId, x]));
  const byVariant = new Map<string, { variantId: string; sku: string; product: string; label: string; retailPrice: number; moq: number; casePack: number; tiers: { minQty: number; unitPrice: number }[] }>();
  for (const i of items) {
    const e = byVariant.get(i.variantId) ?? { variantId: i.variantId, sku: i.variant.sku, product: i.variant.product.name, label: i.variant.label, retailPrice: i.variant.price, moq: t.get(i.variantId)?.moq ?? 1, casePack: t.get(i.variantId)?.casePack ?? 1, tiers: [] };
    e.tiers.push({ minQty: i.minQty, unitPrice: i.unitPrice });
    byVariant.set(i.variantId, e);
  }
  return json({ paymentTerms: account.paymentTerms, items: [...byVariant.values()] });
}
