import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { fail } from "@/lib/api";
import { allowedOriginsFromEnv, isMutation, isSameOrigin } from "./origin";
import { hasPermission, type Permission } from "./roles";
import { writeAudit } from "./audit";

/**
 * Admin authentication and authorisation (M4, ADR 0012).
 *  - Sessions are rows in AdminSession. The cookie carries a random token; the database stores only its keyed hash.
 *  - `requireAdmin(req, permission)` is the one gate every admin route calls: same-origin check for mutations,
 *    valid unrevoked session, then the role's permission. 401 = no session, 403 = wrong origin or role.
 *  - Logout and password changes revoke server-side; a revoked or expired session is dead on the next request.
 */
export const SESSION_COOKIE = "vv_admin";
export const SESSION_MAX_AGE_S = 60 * 60 * 8; // absolute lifetime
export const SESSION_IDLE_MS = 2 * 60 * 60_000; // unused for this long = expired
const TOUCH_EVERY_MS = 60_000;
const MIN_SECRET = 24;

export interface AdminContext {
  sessionId: string;
  userId: string | null;
  /** email, or "legacy" for the shared ADMIN_PASSWORD session */
  label: string;
  role: AdminRole;
  legacy: boolean;
  /** id recorded as the actor on order events and ledger rows */
  actorId: string;
  can(permission: Permission): boolean;
}

/** Cookie signing key. Required: it keys the session-token hash. */
export const adminConfigured = () => (process.env.SESSION_SECRET ?? "").length >= MIN_SECRET;

/** The shared-password login is a transition aid: on while ADMIN_PASSWORD is set, off with ADMIN_LEGACY_LOGIN=off. */
export const legacyLoginEnabled = () => !!process.env.ADMIN_PASSWORD && process.env.ADMIN_LEGACY_LOGIN?.trim().toLowerCase() !== "off";

const tokenHash = (token: string) => {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < MIN_SECRET) throw new Error("SESSION_SECRET must be set (24+ characters)");
  return crypto.createHmac("sha256", key).update(`admin-session:${token}`).digest("hex");
};

export const cookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE_S });

function tokenFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** Creates a session and returns the token to put in the cookie. */
export async function createSession(input: { userId: string } | { legacy: true }, userAgent?: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.adminSession.create({
    data: {
      tokenHash: tokenHash(token),
      userId: "userId" in input ? input.userId : null,
      legacy: "legacy" in input,
      userAgent: userAgent?.slice(0, 200) || null,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_S * 1000),
    },
  });
  return token;
}

async function loadSession(token: string | null, now = new Date()): Promise<AdminContext | null> {
  if (!token || !adminConfigured()) return null;
  const s = await db.adminSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
  if (!s.legacy && (!s.user || !s.user.active)) return null;
  if (s.legacy && !legacyLoginEnabled()) return null; // turning the legacy login off also ends its live sessions
  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) await db.adminSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: now } });
  const role: AdminRole = s.legacy ? "owner" : s.user!.role;
  const legacy = s.legacy;
  return {
    sessionId: s.id,
    userId: s.userId,
    label: legacy ? "legacy" : s.user!.email,
    role,
    legacy,
    actorId: s.userId ?? "legacy",
    can: (p) => hasPermission(role, p, legacy),
  };
}

export const sessionFromRequest = (req: Request) => loadSession(tokenFromCookieHeader(req.headers.get("cookie")));

/** For server components (the dashboard page): is there a valid admin session? */
export async function isAdmin(): Promise<boolean> {
  try {
    return (await loadSession((await cookies()).get(SESSION_COOKIE)?.value ?? null)) !== null;
  } catch {
    return false;
  }
}

/**
 * The gate for every admin route. Usage:
 *   const auth = await requireAdmin(req, "orders:write");
 *   if ("response" in auth) return auth.response;
 *   auth.admin ...
 */
export async function requireAdmin(req: Request, permission: Permission): Promise<{ admin: AdminContext } | { response: Response }> {
  if (isMutation(req.method) && !isSameOrigin(req.headers, req.method, allowedOriginsFromEnv())) {
    await writeAudit({ action: "request.cross_origin", outcome: "denied", details: { method: req.method } });
    return { response: fail("Cross-origin request refused", 403) };
  }
  const admin = await sessionFromRequest(req);
  if (!admin) return { response: fail("Unauthorized", 401) };
  if (!admin.can(permission)) {
    await writeAudit({ action: "access.denied", outcome: "denied", admin, details: { permission, method: req.method } });
    return { response: fail("You do not have permission to do this", 403) };
  }
  return { admin };
}

/** Same-origin gate for admin endpoints that run before a session exists (login). */
export function requireSameOrigin(req: Request): Response | null {
  return isSameOrigin(req.headers, req.method, allowedOriginsFromEnv()) ? null : fail("Cross-origin request refused", 403);
}

export async function revokeSession(sessionId: string): Promise<boolean> {
  return (await db.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } })).count === 1;
}

/** Ends every live session of a user (deactivation, role change, password reset), optionally keeping one. */
export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  return (await db.adminSession.updateMany({ where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, data: { revokedAt: new Date() } })).count;
}

export const tokenFromRequest = (req: Request) => tokenFromCookieHeader(req.headers.get("cookie"));
export const hashSessionToken = tokenHash;
