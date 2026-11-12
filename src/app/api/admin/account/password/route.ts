import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { changeOwnPassword } from "@/lib/auth/users";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

/** Change your own password. Ends all your other sessions. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const { admin } = auth;
  if (!admin.userId) return fail("The shared-password session has no personal password to change", 409);
  if (!(await rateLimit("admin-password", 8, 15 * 60_000))) return fail("Too many attempts. Try again later.", 429);
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const r = await changeOwnPassword(admin.userId, parsed.data.currentPassword, parsed.data.newPassword, admin.sessionId);
  if (!r.ok) {
    await writeAudit({ action: "password.change", outcome: "rejected", admin, details: { code: r.code } });
    return r.code === "wrong_password" ? fail(r.message, 422, { currentPassword: r.message }) : fail(r.message, 422, { newPassword: r.message });
  }
  await writeAudit({ action: "password.change", outcome: "success", admin, details: { sessionsRevoked: r.sessionsRevoked } });
  return json({ ok: true, sessionsRevoked: r.sessionsRevoked });
}
