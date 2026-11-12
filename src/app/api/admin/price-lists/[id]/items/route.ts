import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { priceTiersSchema } from "@/lib/wholesale/schemas";

/**
 * Replace ALL tiers of one variant in a list (`tiers: []` removes it). Rules: distinct `minQty`, unit prices never rise as
 * the quantity rises, and no tier above the variant's MRP. Amounts are paise.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "pricing:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, priceTiersSchema);
  if ("response" in parsed) return parsed.response;
  const { variantId, tiers } = parsed.data;
  const audit = (outcome: "success" | "rejected", code?: string) => writeAudit({ action: "price_list.items", outcome, admin: auth.admin, targetType: "price_list", targetId: id, details: { variantId, tiers: tiers.length, ...(code ? { code } : {}) } });

  const [list, variant] = await Promise.all([db.priceList.findUnique({ where: { id }, select: { id: true } }), db.variant.findUnique({ where: { id: variantId }, select: { id: true, mrp: true } })]);
  if (!list || !variant) {
    await audit("rejected", "not_found");
    return fail(!list ? "Price list not found" : "Variant not found", 404);
  }
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  const problem =
    new Set(sorted.map((t) => t.minQty)).size !== sorted.length ? "Each tier needs a different minimum quantity" :
    sorted.some((t, i) => i > 0 && t.unitPrice > sorted[i - 1].unitPrice) ? "A larger quantity must not cost more per unit" :
    sorted.some((t) => t.unitPrice > variant.mrp) ? "A tier price cannot be above the MRP" : null;
  if (problem) {
    await audit("rejected", "invalid_tiers");
    return fail(problem, 422, { tiers: problem });
  }
  await db.$transaction([db.priceListItem.deleteMany({ where: { priceListId: id, variantId } }), ...(sorted.length ? [db.priceListItem.createMany({ data: sorted.map((t) => ({ priceListId: id, variantId, minQty: t.minQty, unitPrice: t.unitPrice })) })] : [])]);
  await audit("success");
  return json({ ok: true, tiers: sorted });
}
