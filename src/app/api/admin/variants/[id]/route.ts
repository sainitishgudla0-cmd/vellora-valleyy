import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { isAdmin } from "@/lib/admin-auth";

const schema = z.object({
  /** rupees */
  price: z.number().positive().max(100000).optional(),
  inStock: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const { price, inStock } = parsed.data;
  const v = await db.variant
    .update({
      where: { id: id },
      data: { ...(price !== undefined && { price: Math.round(price * 100) }), ...(inStock !== undefined && { inStock }) },
    })
    .catch(() => null);
  return v ? json({ ok: true, price: v.price, inStock: v.inStock }) : fail("Variant not found", 404);
}
