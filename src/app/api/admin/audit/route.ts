import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
  action: z.string().max(60).optional(),
});

/** Owner-only read of the audit log, newest first. Page with `before=<createdAt of the last row>`. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "users:manage");
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const parsed = query.safeParse({ limit: sp.get("limit") ?? undefined, before: sp.get("before") ?? undefined, action: sp.get("action") ?? undefined });
  if (!parsed.success) return fail("Invalid query", 422);
  const { limit, before, action } = parsed.data;
  const rows = await db.auditLog.findMany({
    where: { ...(before ? { createdAt: { lt: new Date(before) } } : {}), ...(action ? { action } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return json({ entries: rows });
}
