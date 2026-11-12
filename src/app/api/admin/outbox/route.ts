import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { outboxQuery } from "@/lib/fulfilment/schemas";

export const dynamic = "force-dynamic";

/** The notification queue (no recipients, no content: templates and subjects only). `?status=dead` shows what gave up. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = outboxQuery.safeParse({ status: sp.get("status") ?? undefined, limit: sp.get("limit") ?? undefined });
  if (!q.success) return fail("Invalid query", 422);
  const rows = await db.outboxMessage.findMany({ where: q.data.status ? { status: q.data.status } : {}, orderBy: { createdAt: "desc" }, take: q.data.limit });
  return json({ messages: rows.map((m) => ({ id: m.id, template: m.template, subjectType: m.subjectType, subjectId: m.subjectId, status: m.status, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lastError: m.lastError, createdAt: m.createdAt, sentAt: m.sentAt })) });
}
