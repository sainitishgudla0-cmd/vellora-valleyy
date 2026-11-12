import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { fail } from "@/lib/api";
import { allowedOriginsFromEnv, isMutation, isSameOrigin } from "./origin";

/**
 * Customer sessions (M5, ADR 0013): the same design as admin sessions (random cookie token, only a keyed hash in the
 * database, revocable, idle and absolute expiry) with a longer life, since shoppers sign in far less often.
 * `requireCustomer(req)` is the gate for every /api/account route except sign-in itself.
 */
export const CUSTOMER_COOKIE = "vv_customer";
export const CUSTOMER_SESSION_MAX_AGE_S = 30 * 24 * 3600;
export const CUSTOMER_SESSION_IDLE_MS = 14 * 24 * 3600_000;
const TOUCH_EVERY_MS = 5 * 60_000;
const MIN_SECRET = 24;

export interface CustomerContext {
  customerId: string;
  email: string;
  sessionId: string;
  /** when this session was created: sensitive actions (erasure) need a recent sign-in */
  signedInAt: Date;
}

export const customerAuthConfigured = () => (process.env.SESSION_SECRET ?? "").length >= MIN_SECRET;

function key() {
  const k = process.env.SESSION_SECRET;
  if (!k || k.length < MIN_SECRET) throw new Error("SESSION_SECRET must be set (24+ characters)");
  return k;
}

/** Keyed hash with a purpose prefix, so a token hash can never double as an address or code hash. */
export const keyedHash = (purpose: string, value: string) => crypto.createHmac("sha256", key()).update(`${purpose}:${value}`).digest("hex");

export const cookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: CUSTOMER_SESSION_MAX_AGE_S });

function tokenFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === CUSTOMER_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export async function createCustomerSession(customerId: string, userAgent?: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.customerSession.create({
    data: { customerId, tokenHash: keyedHash("customer-session", token), userAgent: userAgent?.slice(0, 200) || null, expiresAt: new Date(Date.now() + CUSTOMER_SESSION_MAX_AGE_S * 1000) },
  });
  return token;
}

export async function customerFromRequest(req: Request, now = new Date()): Promise<CustomerContext | null> {
  const token = tokenFromCookieHeader(req.headers.get("cookie"));
  if (!token || !customerAuthConfigured()) return null;
  const s = await db.customerSession.findUnique({ where: { tokenHash: keyedHash("customer-session", token) }, include: { customer: { select: { id: true, email: true } } } });
  if (!s || s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > CUSTOMER_SESSION_IDLE_MS) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) await db.customerSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: now } });
  return { customerId: s.customer.id, email: s.customer.email, sessionId: s.id, signedInAt: s.createdAt };
}

/** 401 without a session, 403 for a cross-origin mutation, 403 `reauth_required` when `recentMs` is given and the sign-in is older. */
export async function requireCustomer(req: Request, opts: { recentMs?: number } = {}): Promise<{ customer: CustomerContext } | { response: Response }> {
  if (isMutation(req.method) && !isSameOrigin(req.headers, req.method, allowedOriginsFromEnv())) return { response: fail("Cross-origin request refused", 403) };
  const customer = await customerFromRequest(req);
  if (!customer) return { response: fail("Please sign in", 401) };
  if (opts.recentMs !== undefined && Date.now() - customer.signedInAt.getTime() > opts.recentMs) {
    return { response: Response.json({ error: "Please sign in again to do this", code: "reauth_required" }, { status: 403 }) };
  }
  return { customer };
}

export const requireCustomerSameOrigin = (req: Request): Response | null => (isSameOrigin(req.headers, req.method, allowedOriginsFromEnv()) ? null : fail("Cross-origin request refused", 403));

export async function revokeCustomerSession(sessionId: string) {
  return (await db.customerSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } })).count === 1;
}

export async function revokeAllCustomerSessions(customerId: string, exceptSessionId?: string) {
  return (await db.customerSession.updateMany({ where: { customerId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, data: { revokedAt: new Date() } })).count;
}
