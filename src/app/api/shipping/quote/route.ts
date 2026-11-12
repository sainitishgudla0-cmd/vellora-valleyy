import { fail, json } from "@/lib/api";
import { db } from "@/lib/db";
import { shippingQuoteQuery } from "@/lib/fulfilment/schemas";
import { quoteShipping } from "@/lib/shipping/rules";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Public: is this pincode served, and what would delivery cost for a subtotal (paise)? The same rules `POST /api/orders` applies. */
export async function GET(req: Request) {
  if (!(await rateLimit("shipping-quote", 60, 10 * 60_000))) return fail("Too many requests. Please try again later.", 429);
  const sp = new URL(req.url).searchParams;
  const q = shippingQuoteQuery.safeParse({ pincode: sp.get("pincode") ?? undefined, subtotal: sp.get("subtotal") ?? undefined });
  if (!q.success) return fail("Enter a valid 6-digit pincode", 422, { pincode: "Enter a valid 6-digit pincode" });
  const s = await quoteShipping(db, q.data.pincode, q.data.subtotal);
  return json({ serviceable: s.serviceable, fee: s.fee, freeAboveSubtotal: s.freeAboveSubtotal, ruleBased: !s.legacy });
}
