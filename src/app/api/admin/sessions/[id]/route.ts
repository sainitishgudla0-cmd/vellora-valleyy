import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin, revokeSession } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";

/** Revoke a session: your own, or any (owners). The cookie holding it stops working on its next request. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const { admin } = auth;
  const { id } = await params;
  const target = await db.adminSession.findUnique({ where: { id }, select: { id: true, userId: true } });
  // someone else's session id is indistinguishable from a missing one unless you may manage users
  if (!target || (target.userId !== admin.userId && !admin.can("users:manage"))) return fail("Session not found", 404);
  const revoked = await revokeSession(id);
  await writeAudit({ action: "session.revoke", outcome: revoked ? "success" : "rejected", admin, targetType: "admin_session", targetId: id });
  return json({ ok: true, revoked });
}
