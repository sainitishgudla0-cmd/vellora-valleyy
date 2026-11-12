import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { PERMISSIONS } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/** Who am I: the signed-in account, its role and what it may do. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const { admin } = auth;
  const user = admin.userId ? await db.adminUser.findUnique({ where: { id: admin.userId }, select: { name: true } }) : null;
  return json({ email: admin.userId ? admin.label : null, name: user?.name ?? null, role: admin.role, legacy: admin.legacy, permissions: PERMISSIONS.filter((p) => admin.can(p)) });
}
