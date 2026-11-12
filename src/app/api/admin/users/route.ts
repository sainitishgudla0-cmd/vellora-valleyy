import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { createUser, listUsers } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

const schema = z.strictObject({
  email: z.string().trim().toLowerCase().max(200).pipe(z.email()),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ADMIN_ROLES),
  password: z.string().min(1).max(200),
});

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "users:manage");
  if ("response" in auth) return auth.response;
  return json({ users: await listUsers() });
}

/** Owner creates an account with an initial password (shared out of band; the person can change it). */
export async function POST(req: Request) {
  const auth = await requireAdmin(req, "users:manage");
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const r = await createUser(parsed.data);
  if (!r.ok) {
    await writeAudit({ action: "user.create", outcome: "rejected", admin: auth.admin, details: { code: r.code } });
    return r.code === "email_in_use" ? Response.json({ error: r.message, code: r.code }, { status: 409 }) : fail(r.message, 422, { password: r.message });
  }
  await writeAudit({ action: "user.create", outcome: "success", admin: auth.admin, targetType: "admin_user", targetId: r.user.id, details: { role: r.user.role } });
  return json({ user: r.user }, 201);
}
