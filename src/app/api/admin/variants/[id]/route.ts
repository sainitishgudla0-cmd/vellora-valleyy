import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { isAdmin } from "@/lib/admin-auth";
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
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const { price, inStock, trackInventory, stockAdjust } = parsed.data;

  if (trackInventory !== undefined || stockAdjust) {
    const r = await updateVariantInventory({ variantId: id, actor: { type: "admin", id: "admin" }, trackInventory, reason: parsed.data.reason, stockAdjust });
    if (!r.ok) return r.code === "not_found" ? fail(r.message, 404) : conflict(r.code, r.message);
  }

  const current = await db.variant.findUnique({ where: { id }, select: { trackInventory: true } });
  if (!current) return fail("Variant not found", 404);
  const v = await db.variant
    .update({
      where: { id },
      data: { ...(price !== undefined && { price: Math.round(price * 100) }), ...(inStock !== undefined && !current.trackInventory && { inStock }) },
    })
    .catch(() => null);
  if (!v) return fail("Variant not found", 404);
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
