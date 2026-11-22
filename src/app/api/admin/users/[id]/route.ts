import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { updateUser } from "@/lib/auth/users";

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

  // Successes are audited inside each change's transaction (P1-T4); only rejections are written here, best-effort.
  const rejected = (code: string) => writeAudit({ action: "user.update", outcome: "rejected", admin: auth.admin, targetType: "admin_user", targetId: id, details: { fields, code } });

  // M12 VA-04: fields and an optional password reset are ONE change (validated first, one transaction, both audit rows
  // in it), so a 4xx never leaves half of the request applied.
  const r = await updateUser(id, patch, auth.admin, { password });
  if (!r.ok) {
    await rejected(r.code);
    if (r.code === "not_found") return fail(r.message, 404);
    if (r.code === "weak_password") return fail(r.message, 422, { password: r.message });
    return Response.json({ error: r.message, code: r.code }, { status: 409 });
  }
  const sessionsRevoked = r.sessionsRevoked;
  return json({ ok: true, sessionsRevoked });
}
