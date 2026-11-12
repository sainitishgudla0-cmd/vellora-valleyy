import { NextResponse } from "next/server";
import { requireSameOrigin, revokeSession, sessionFromRequest, SESSION_COOKIE } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";

/** Revokes the session server-side (a copied cookie stops working), then clears the cookie. Always `{ ok: true }`. */
export async function POST(req: Request) {
  const cross = requireSameOrigin(req);
  if (cross) return cross;
  const admin = await sessionFromRequest(req);
  if (admin) {
    await revokeSession(admin.sessionId);
    await writeAudit({ action: "logout", outcome: "success", admin });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
