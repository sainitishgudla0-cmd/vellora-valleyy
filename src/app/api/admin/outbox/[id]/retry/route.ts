import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";

/** Put a dead or failed notification back in the queue for another round of attempts. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const r = await db.outboxMessage.updateMany({ where: { id, status: { in: ["dead", "failed"] } }, data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, claimedAt: null } });
  await writeAudit({ action: "outbox.retry", outcome: r.count ? "success" : "rejected", admin: auth.admin, targetType: "outbox_message", targetId: id });
  return r.count ? json({ ok: true }) : fail("Only a failed or dead message can be retried", 404);
}
