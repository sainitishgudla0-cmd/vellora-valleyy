import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { priceListPatchSchema } from "@/lib/wholesale/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const l = await db.priceList.findUnique({ where: { id }, include: { items: { orderBy: [{ variantId: "asc" }, { minQty: "asc" }], include: { variant: { select: { sku: true, label: true, price: true, mrp: true, product: { select: { name: true } } } } } } } });
  if (!l) return fail("Price list not found", 404);
  return json({ priceList: { id: l.id, name: l.name, description: l.description, active: l.active, items: l.items.map((i) => ({ variantId: i.variantId, sku: i.variant.sku, product: i.variant.product.name, label: i.variant.label, retailPrice: i.variant.price, mrp: i.variant.mrp, minQty: i.minQty, unitPrice: i.unitPrice })) } });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "pricing:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, priceListPatchSchema);
  if ("response" in parsed) return parsed.response;
  const audit = (outcome: "success" | "rejected", code?: string) => writeAudit({ action: "price_list.update", outcome, admin: auth.admin, targetType: "price_list", targetId: id, details: { fields: Object.keys(parsed.data), ...(code ? { code } : {}) } });
  try {
    const l = await db.priceList.update({ where: { id }, data: parsed.data });
    await audit("success");
    return json({ ok: true, priceList: { id: l.id, name: l.name, description: l.description, active: l.active } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2025" || e.code === "P2002")) {
      await audit("rejected", e.code === "P2025" ? "not_found" : "name_in_use");
      return e.code === "P2025" ? fail("Price list not found", 404) : Response.json({ error: "A price list with this name already exists", code: "name_in_use" }, { status: 409 });
    }
    throw e;
  }
}

/** Only an unused list can be deleted; otherwise deactivate it (accounts then fall back to retail prices). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "pricing:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const l = await db.priceList.findUnique({ where: { id }, include: { _count: { select: { accounts: true } } } });
  if (!l) {
    await writeAudit({ action: "price_list.delete", outcome: "rejected", admin: auth.admin, targetType: "price_list", targetId: id, details: { code: "not_found" } });
    return fail("Price list not found", 404);
  }
  if (l._count.accounts > 0) {
    await writeAudit({ action: "price_list.delete", outcome: "rejected", admin: auth.admin, targetType: "price_list", targetId: id, details: { code: "in_use" } });
    return Response.json({ error: "Accounts still use this price list. Deactivate it instead.", code: "in_use" }, { status: 409 });
  }
  await db.priceList.delete({ where: { id } });
  await writeAudit({ action: "price_list.delete", outcome: "success", admin: auth.admin, targetType: "price_list", targetId: id });
  return json({ ok: true });
}
