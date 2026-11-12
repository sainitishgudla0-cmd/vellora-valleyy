import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const query = z.object({ status: z.enum(["requested", "quoted", "accepted", "declined", "expired", "rejected", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Quote queue (`?status=requested` = waiting for a price). */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ status: sp.get("status") ?? undefined, limit: sp.get("limit") ?? undefined });
  if (!q.success) return fail("Invalid query", 422);
  const rows = await db.quote.findMany({ where: q.data.status ? { status: q.data.status } : {}, orderBy: { createdAt: "desc" }, take: q.data.limit, include: { businessAccount: { select: { companyName: true } }, _count: { select: { items: true } } } });
  return json({ quotes: rows.map((r) => ({ id: r.id, number: r.number, status: r.status, company: r.businessAccount.companyName, items: r._count.items, total: r.total, validUntil: r.validUntil, createdAt: r.createdAt })) });
}
