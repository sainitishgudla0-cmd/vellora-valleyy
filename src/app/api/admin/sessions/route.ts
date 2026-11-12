import { json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { listSessions } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/** Your live sessions; owners may list everyone's with `?all=1`. Never returns tokens. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const { admin } = auth;
  const all = new URL(req.url).searchParams.get("all") === "1" && admin.can("users:manage");
  const sessions = all ? await listSessions() : admin.userId ? await listSessions(admin.userId) : [];
  return json({ sessions: sessions.map((s) => ({ ...s, current: s.id === admin.sessionId })) });
}
