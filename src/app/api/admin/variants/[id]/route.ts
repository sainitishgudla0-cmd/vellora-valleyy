import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { effectiveInStock } from "@/lib/inventory/availability";
import { MAX_STOCK_DELTA, updateVariantInventory } from "@/lib/inventory/adjust";

const reason = z.string().trim().min(3).max(200);
const schema = z
  .object({
    /** rupees */
    price: z.number().positive().max(100000).optional(),
    /** Manual availability flag. Ignored for variants whose inventory is tracked (counts decide). */
    inStock: z.boolean().optional(),
    /** true = count units from now on; false = back to the manual flag (needs zero reserved units). Requires `reason`. */
    trackInventory: z.boolean().optional(),
    reason: reason.optional(),
    /** Signed change in units on hand, with the reason recorded in the audit ledger. */
    stockAdjust: z.object({ delta: z.number().int().min(-MAX_STOCK_DELTA).max(MAX_STOCK_DELTA).refine((n) => n !== 0, "delta must not be 0"), reason }).optional(),
  })
  .refine((b) => b.trackInventory === undefined || b.reason !== undefined, { message: "A reason is required to change inventory tracking", path: ["reason"] });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "variants:write");
  if ("response" in auth) return auth.response;
  const { admin } = auth;
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const { price, inStock, trackInventory, stockAdjust } = parsed.data;

  // The endpoint is open to catalog and operations staff; each field has its own permission.
  const touchesCatalog = price !== undefined || inStock !== undefined;
  const touchesInventory = trackInventory !== undefined || stockAdjust !== undefined;
  const audit = (outcome: "success" | "rejected" | "denied", extra: Record<string, unknown> = {}) =>
    writeAudit({
      action: "variant.update",
      outcome,
      admin,
      targetType: "variant",
      targetId: id,
      details: { fields: Object.keys(parsed.data).filter((k) => k !== "reason"), ...(stockAdjust ? { stockDelta: stockAdjust.delta } : {}), ...extra },
    });
  if ((touchesCatalog && !admin.can("catalog:write")) || (touchesInventory && !admin.can("inventory:write"))) {
    await audit("denied");
    return fail("You do not have permission to change these fields", 403);
  }

  if (touchesInventory) {
    const r = await updateVariantInventory({ variantId: id, actor: { type: "admin", id: admin.actorId }, trackInventory, reason: parsed.data.reason, stockAdjust });
    if (!r.ok) {
      await audit("rejected", { code: r.code });
      return r.code === "not_found" ? fail(r.message, 404) : conflict(r.code, r.message);
    }
  }

  const current = await db.variant.findUnique({ where: { id }, select: { trackInventory: true } });
  if (!current) {
    await audit("rejected", { code: "not_found" });
    return fail("Variant not found", 404);
  }
  const v = await db.variant
    .update({
      where: { id },
      data: { ...(price !== undefined && { price: Math.round(price * 100) }), ...(inStock !== undefined && !current.trackInventory && { inStock }) },
    })
    .catch(() => null);
  if (!v) {
    await audit("rejected", { code: "not_found" });
    return fail("Variant not found", 404);
  }
  await audit("success");
  return json({
    ok: true,
    price: v.price,
    inStock: effectiveInStock(v),
    trackInventory: v.trackInventory,
    ...(v.trackInventory && { stockQuantity: v.stockQuantity, reserved: v.reserved, available: Math.max(0, v.stockQuantity - v.reserved) }),
  });
}

function conflict(code: string, message: string) {
  return Response.json({ error: message, code }, { status: 409 });
}
