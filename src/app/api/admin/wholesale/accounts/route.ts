import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { accountAdminView } from "@/lib/wholesale/views";

export const dynamic = "force-dynamic";

const query = z.object({ status: z.enum(["pending", "approved", "rejected", "suspended", "closed"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Business accounts and applications, newest first (`?status=pending` for the approval queue). */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ status: sp.get("status") ?? undefined, limit: sp.get("limit") ?? undefined });
  if (!q.success) return fail("Invalid query", 422);
  const rows = await db.businessAccount.findMany({ where: q.data.status ? { status: q.data.status } : {}, orderBy: { createdAt: "desc" }, take: q.data.limit });
  return json({ accounts: rows.map(accountAdminView) });
}
