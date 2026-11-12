import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { burnPasswordCheck, verifyPassword } from "./password";
import { createSession, legacyLoginEnabled } from "./admin";
import { writeAudit } from "./audit";

/** Account lockout (M4): this many consecutive wrong passwords lock the account for LOCK_MS. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;

export type LoginResult = { ok: true; token: string; userId: string | null; legacy: boolean } | { ok: false; reason: "invalid" | "locked" | "disabled" };

const normEmail = (e: string) => e.trim().toLowerCase();
/** Short stable fingerprint for audit rows about unknown addresses (no raw attempted email is stored). */
const fingerprint = (email: string) => crypto.createHash("sha256").update(email).digest("hex").slice(0, 10);

/**
 * Email + password login. Every failure looks the same to the caller ("invalid"); the real reason (locked, disabled,
 * unknown account) goes to the audit log. A burned password check keeps response times alike.
 */
export async function loginWithPassword(emailInput: string, password: string, userAgent?: string | null, now = new Date()): Promise<LoginResult> {
  const email = normEmail(emailInput);
  const user = await db.adminUser.findUnique({ where: { email } });
  if (!user) {
    await burnPasswordCheck(password);
    await writeAudit({ action: "login.failure", outcome: "failed", details: { reason: "unknown_account", attempt: fingerprint(email) } });
    return { ok: false, reason: "invalid" };
  }
  const who = { userId: user.id, label: user.email, role: user.role };
  if (!user.active) {
    await burnPasswordCheck(password);
    await writeAudit({ action: "login.failure", outcome: "failed", admin: who, details: { reason: "disabled" } });
    return { ok: false, reason: "disabled" };
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    await burnPasswordCheck(password);
    await writeAudit({ action: "login.failure", outcome: "failed", admin: who, details: { reason: "locked" } });
    return { ok: false, reason: "locked" };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const updated = await db.adminUser.update({ where: { id: user.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
    const lock = updated.failedLogins >= MAX_FAILED_LOGINS;
    if (lock) await db.adminUser.update({ where: { id: user.id }, data: { lockedUntil: new Date(now.getTime() + LOCK_MS) } });
    await writeAudit({ action: lock ? "login.locked" : "login.failure", outcome: "failed", admin: who, details: { reason: "bad_password", failedLogins: updated.failedLogins } });
    return { ok: false, reason: "invalid" };
  }
  await db.adminUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  const token = await createSession({ userId: user.id }, userAgent);
  await writeAudit({ action: "login.success", outcome: "success", admin: who });
  await db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } } }); // housekeeping
  return { ok: true, token, userId: user.id, legacy: false };
}

/** Transition login with the shared ADMIN_PASSWORD (no email). Disabled with ADMIN_LEGACY_LOGIN=off. */
export async function loginLegacy(password: string, userAgent?: string | null): Promise<LoginResult> {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!legacyLoginEnabled() || !crypto.timingSafeEqual(a, b)) {
    await writeAudit({ action: "login.failure", outcome: "failed", details: { reason: legacyLoginEnabled() ? "bad_legacy_password" : "legacy_disabled" } });
    return { ok: false, reason: "invalid" };
  }
  const token = await createSession({ legacy: true }, userAgent);
  await writeAudit({ action: "login.success", outcome: "success", admin: { userId: null, label: "legacy", role: "owner" }, details: { legacy: true } });
  return { ok: true, token, userId: null, legacy: true };
}
