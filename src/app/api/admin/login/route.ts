import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, parseBody } from "@/lib/api";
import { adminConfigured, cookieOptions, requireSameOrigin, revokeSession, sessionFromRequest, SESSION_COOKIE } from "@/lib/auth/admin";
import { loginLegacy, loginWithPassword } from "@/lib/auth/login";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

// `email` is optional only for the transition: without it the shared ADMIN_PASSWORD login is attempted (ADR 0012).
const schema = z.object({ email: z.string().trim().min(3).max(200).optional(), password: z.string().min(1).max(200) });

/** Contract: docs/API-CONTRACTS.md (Admin). Every failure is the same 401; the reason is only in the audit log. */
export async function POST(req: Request) {
  const cross = requireSameOrigin(req);
  if (cross) return cross;
  if (!adminConfigured()) return fail("Admin is not configured. Set SESSION_SECRET (24+ characters) and create an owner account.", 503);
  if (!(await rateLimit("admin-login", 8, 15 * 60_000))) return fail("Too many attempts. Try again later.", 429);
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const { email, password } = parsed.data;

  const ua = req.headers.get("user-agent");
  const result = email ? await loginWithPassword(email, password, ua) : await loginLegacy(password, ua);
  if (!result.ok) return fail(email ? "Incorrect email or password" : "Incorrect password", 401);

  // a new session replaces any session the browser already held (no fixation)
  const previous = await sessionFromRequest(req);
  if (previous) await revokeSession(previous.sessionId);
  const role = result.userId ? (await db.adminUser.findUnique({ where: { id: result.userId }, select: { role: true } }))?.role : undefined;
  const res = NextResponse.json(role ? { ok: true, role } : { ok: true });
  res.cookies.set(SESSION_COOKIE, result.token, cookieOptions());
  return res;
}
