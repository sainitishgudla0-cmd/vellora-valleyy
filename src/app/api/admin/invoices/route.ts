import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), fy: z.string().regex(/^\d{4}-\d{2}$/).optional() });

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ limit: sp.get("limit") ?? undefined, fy: sp.get("fy") ?? undefined });
  if (!q.success) return fail("Invalid query", 422);
  const rows = await db.invoice.findMany({ where: q.data.fy ? { financialYear: q.data.fy } : {}, orderBy: [{ financialYear: "desc" }, { seq: "desc" }], take: q.data.limit, include: { order: { select: { number: true } } } });
  return json({ invoices: rows.map((i) => ({ id: i.id, number: i.number, orderNumber: i.order.number, issuedAt: i.issuedAt, supplyType: i.supplyType, taxable: i.taxableTotal, cgst: i.cgstTotal, sgst: i.sgstTotal, igst: i.igstTotal, total: i.total, buyerGstin: i.buyerGstin })) });
}
