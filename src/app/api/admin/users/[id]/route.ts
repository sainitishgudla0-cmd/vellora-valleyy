import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { resetPassword, updateUser } from "@/lib/auth/users";

const schema = z.strictObject({
  role: z.enum(ADMIN_ROLES).optional(),
  active: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  /** clear the failed-login counter and any lock */
  unlock: z.literal(true).optional(),
  /** reset the password (ends all of the user's sessions) */
  password: z.string().min(1).max(200).optional(),
});

/** Owner changes an account: role, active flag, name, unlock, password reset. The last active owner is protected. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "users:manage");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const { password, ...patch } = parsed.data;
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) return fail("Nothing to change", 422);

  const audit = (outcome: "success" | "rejected", extra: Record<string, unknown>) =>
    writeAudit({ action: "user.update", outcome, admin: auth.admin, targetType: "admin_user", targetId: id, details: { fields, ...extra } });

  let sessionsRevoked = 0;
  if (Object.keys(patch).length > 0) {
    const r = await updateUser(id, patch);
    if (!r.ok) {
      await audit("rejected", { code: r.code });
      return r.code === "not_found" ? fail(r.message, 404) : Response.json({ error: r.message, code: r.code }, { status: 409 });
    }
    sessionsRevoked += r.sessionsRevoked;
  }
  if (password !== undefined) {
    const r = await resetPassword(id, password);
    if (!r.ok) {
      await audit("rejected", { code: r.code });
      return r.code === "not_found" ? fail(r.message, 404) : fail(r.message, 422, { password: r.message });
    }
    sessionsRevoked += r.sessionsRevoked;
  }
  await audit("success", { sessionsRevoked });
  return json({ ok: true, sessionsRevoked });
}
