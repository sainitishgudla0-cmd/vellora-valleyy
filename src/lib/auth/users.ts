import "server-only";
import { Prisma, type AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditTx, type AuditActor } from "./audit";
import { hashPassword, passwordProblem, verifyPassword } from "./password";

/**
 * Account management (M4-T6 API; owners only, enforced by the routes). Every change that affects access revokes sessions.
 * Every successful change writes its audit row in the same transaction (M11 P1-T4): no audit, no change.
 */
export type UserErrorCode = "not_found" | "email_in_use" | "weak_password" | "last_owner" | "wrong_password";
export type UserResult<T = object> = ({ ok: true } & T) | { ok: false; code: UserErrorCode; message: string };
const fail = (code: UserErrorCode, message: string): { ok: false; code: UserErrorCode; message: string } => ({ ok: false, code, message });

export const publicUser = { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true, failedLogins: true, lockedUntil: true } as const;
type PublicUser = Prisma.AdminUserGetPayload<{ select: typeof publicUser }>;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function createUser(input: { email: string; name: string; role: AdminRole; password: string }, actor: AuditActor): Promise<UserResult<{ user: PublicUser }>> {
  const email = normalizeEmail(input.email);
  const problem = passwordProblem(input.password, email);
  if (problem) return fail("weak_password", problem);
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.$transaction(async (tx) => {
      const u = await tx.adminUser.create({ data: { email, name: input.name.trim(), role: input.role, passwordHash }, select: publicUser });
      await writeAuditTx(tx, { action: "user.create", outcome: "success", admin: actor, targetType: "admin_user", targetId: u.id, details: { role: u.role } });
      return u;
    });
    return { ok: true, user };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return fail("email_in_use", "An account with this email already exists");
    throw e;
  }
}

export const listUsers = () => db.adminUser.findMany({ orderBy: { createdAt: "asc" }, select: publicUser });

/**
 * Role, active flag, name and unlock. The last active owner can never be demoted or deactivated (checked under a row
 * lock, so two owners cannot remove each other at the same time). Role/active changes end the user's sessions.
 */
export async function updateUser(
  id: string,
  patch: { role?: AdminRole; active?: boolean; name?: string; unlock?: boolean },
  actor: AuditActor,
  opts: { password?: string } = {},
): Promise<UserResult<{ user: PublicUser; sessionsRevoked: number }>> {
  // M12 VA-04: an optional password reset is part of the SAME change. It is validated (and hashed) before anything is
  // written, and applied in the same transaction, so a weak password or a failed audit row leaves the account untouched.
  let passwordHash: string | undefined;
  if (opts.password !== undefined) {
    const target = await db.adminUser.findUnique({ where: { id }, select: { email: true } });
    if (!target) return fail("not_found", "Account not found");
    const problem = passwordProblem(opts.password, target.email);
    if (problem) return fail("weak_password", problem);
    passwordHash = await hashPassword(opts.password);
  }
  const hasFields = Object.values(patch).some((v) => v !== undefined);
  return db.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "AdminUser" WHERE "role" = 'owner' AND "active" ORDER BY "id" FOR UPDATE`);
    const current = await tx.adminUser.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!current) return fail("not_found", "Account not found");
    const losesOwner = current.role === "owner" && current.active && ((patch.role && patch.role !== "owner") || patch.active === false);
    if (losesOwner && owners.filter((o) => o.id !== id).length === 0) return fail("last_owner", "There must always be at least one active owner");
    const accessChanged = (patch.role !== undefined && patch.role !== current.role) || (patch.active !== undefined && patch.active !== current.active);
    const user = await tx.adminUser.update({
      where: { id },
      data: {
        ...(patch.role && { role: patch.role }),
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.name && { name: patch.name.trim() }),
        ...((patch.unlock || passwordHash) && { failedLogins: 0, lockedUntil: null }),
        ...(passwordHash && { passwordHash, passwordChangedAt: new Date() }),
      },
      select: publicUser,
    });
    const revoked = accessChanged || passwordHash ? (await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })).count : 0;
    if (hasFields) {
      const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      await writeAuditTx(tx, { action: "user.update", outcome: "success", admin: actor, targetType: "admin_user", targetId: id, details: { fields, ...(patch.role !== undefined && { role: patch.role }), ...(patch.active !== undefined && { active: patch.active }), sessionsRevoked: revoked } });
    }
    if (passwordHash) await writeAuditTx(tx, { action: "user.password_reset", outcome: "success", admin: actor, targetType: "admin_user", targetId: id, details: { sessionsRevoked: revoked } });
    return { ok: true as const, user, sessionsRevoked: revoked };
  });
}

/**
 * Owner recovery (`admin:bootstrap --reset`, M11 P1-T5): in ONE transaction, under a row lock, set a new password on an
 * owner account, reactivate and unlock it, end every one of its sessions AND every shared-password session (a recovery
 * suggests the old credentials may be known to someone else), and write the `owner.recover` audit row. Only owners.
 */
export async function recoverOwner(email: string, newPassword: string, actor: AuditActor): Promise<UserResult<{ userId: string; sessionsRevoked: number; legacySessionsRevoked: number; reactivated: boolean }>> {
  const normalized = normalizeEmail(email);
  const problem = passwordProblem(newPassword, normalized);
  if (problem) return fail("weak_password", problem);
  const passwordHash = await hashPassword(newPassword);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; role: string; active: boolean }[]>(Prisma.sql`SELECT "id", "role"::text AS "role", "active" FROM "AdminUser" WHERE "email" = ${normalized} FOR UPDATE`);
    const u = rows[0];
    if (!u || u.role !== "owner") return fail("not_found", "No owner account with that email.");
    const now = new Date();
    await tx.adminUser.update({ where: { id: u.id }, data: { passwordHash, passwordChangedAt: now, active: true, failedLogins: 0, lockedUntil: null } });
    const own = (await tx.adminSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: now } })).count;
    const legacy = (await tx.adminSession.updateMany({ where: { legacy: true, revokedAt: null }, data: { revokedAt: now } })).count;
    await writeAuditTx(tx, { action: "owner.recover", outcome: "success", admin: actor, targetType: "admin_user", targetId: u.id, details: { reactivated: !u.active, sessionsRevoked: own, legacySessionsRevoked: legacy } });
    return { ok: true as const, userId: u.id, sessionsRevoked: own, legacySessionsRevoked: legacy, reactivated: !u.active };
  });
}

/** Self-service change: needs the current password, ends every OTHER session, keeps the one in use. */
export async function changeOwnPassword(id: string, current: string, next: string, keepSessionId: string, actor: AuditActor): Promise<UserResult<{ sessionsRevoked: number }>> {
  const u = await db.adminUser.findUnique({ where: { id }, select: { email: true, passwordHash: true } });
  if (!u) return fail("not_found", "Account not found");
  if (!(await verifyPassword(current, u.passwordHash))) return fail("wrong_password", "Current password is incorrect");
  const problem = passwordProblem(next, u.email);
  if (problem) return fail("weak_password", problem);
  const passwordHash = await hashPassword(next);
  const revoked = await db.$transaction(async (tx) => {
    // compare-and-set on the hash that was verified (M12 VA-04): if the password changed in between (a parallel change or
    // an owner's reset), the "current password" this request proved is no longer current and nothing is written
    const r = await tx.adminUser.updateMany({ where: { id, passwordHash: u.passwordHash }, data: { passwordHash, passwordChangedAt: new Date() } });
    if (r.count !== 1) return null;
    const n = (await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null, id: { not: keepSessionId } }, data: { revokedAt: new Date() } })).count;
    await writeAuditTx(tx, { action: "password.change", outcome: "success", admin: actor, targetType: "admin_user", targetId: id, details: { sessionsRevoked: n } });
    return n;
  });
  if (revoked === null) return fail("wrong_password", "Current password is incorrect");
  return { ok: true, sessionsRevoked: revoked };
}

export interface SessionRow {
  id: string;
  userId: string | null;
  email: string | null;
  legacy: boolean;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** Live (unrevoked, unexpired) sessions, for one user or everyone. Never returns tokens or hashes. */
export async function listSessions(userId?: string): Promise<SessionRow[]> {
  const rows = await db.adminSession.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() }, ...(userId ? { userId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { email: true } } },
  });
  return rows.map((s) => ({ id: s.id, userId: s.userId, email: s.user?.email ?? null, legacy: s.legacy, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt }));
}
