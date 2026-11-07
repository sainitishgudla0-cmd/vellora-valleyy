import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseBody } from "@/lib/api";

const schema = z.object({ variantIds: z.array(z.string().max(40)).max(60) });

/** Returns current price / availability for the variants in a client cart. */
export async function POST(req: Request) {
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const variants = await db.variant.findMany({
    where: { id: { in: parsed.data.variantIds } },
    include: { product: { select: { active: true } } },
  });
  return json({
    variants: variants.map((v) => ({ id: v.id, price: v.price, mrp: v.mrp, available: v.inStock && v.product.active })),
  });
}
