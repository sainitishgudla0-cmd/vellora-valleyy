import { z } from "zod";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { DEFAULT_LOW_STOCK_THRESHOLD, listLowStock } from "@/lib/inventory/adjust";

export const dynamic = "force-dynamic";

const query = z.object({ threshold: z.coerce.number().int().min(0).max(10000).default(DEFAULT_LOW_STOCK_THRESHOLD) });

/** Tracked variants with at most `threshold` sellable units (default 5), lowest first. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const parsed = query.safeParse({ threshold: new URL(req.url).searchParams.get("threshold") ?? undefined });
  if (!parsed.success) return fail("threshold must be a whole number between 0 and 10000", 422, { threshold: "Invalid threshold" });
  return json({ threshold: parsed.data.threshold, variants: await listLowStock(parsed.data.threshold) });
}
