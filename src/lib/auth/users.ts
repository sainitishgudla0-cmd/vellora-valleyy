import "server-only";
import { Prisma, type AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword, passwordProblem, verifyPassword } from "./password";

/** Account management (M4-T6 API; owners only, enforced by the routes). Every change that affects access revokes sessions. */
export type UserErrorCode = "not_found" | "email_in_use" | "weak_password" | "last_owner" | "wrong_password";
export type UserResult<T = object> = ({ ok: true } & T) | { ok: false; code: UserErrorCode; message: string };
const fail = (code: UserErrorCode, message: string): { ok: false; code: UserErrorCode; message: string } => ({ ok: false, code, message });

export const publicUser = { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true, failedLogins: true, lockedUntil: true } as const;
type PublicUser = Prisma.AdminUserGetPayload<{ select: typeof publicUser }>;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function createUser(input: { email: string; name: string; role: AdminRole; password: string }): Promise<UserResult<{ user: PublicUser }>> {
  const email = normalizeEmail(input.email);
  const problem = passwordProblem(input.password, email);
  if (problem) return fail("weak_password", problem);
  try {
    const user = await db.adminUser.create({ data: { email, name: input.name.trim(), role: input.role, passwordHash: await hashPassword(input.password) }, select: publicUser });
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
export async function updateUser(id: string, patch: { role?: AdminRole; active?: boolean; name?: string; unlock?: boolean }): Promise<UserResult<{ user: PublicUser; sessionsRevoked: number }>> {
  return db.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "AdminUser" WHERE "role" = 'owner' AND "active" ORDER BY "id" FOR UPDATE`);
    const current = await tx.adminUser.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!current) return fail("not_found", "Account not found");
    const losesOwner = current.role === "owner" && current.active && ((patch.role && patch.role !== "owner") || patch.active === false);
    if (losesOwner && owners.filter((o) => o.id !== id).length === 0) return fail("last_owner", "There must always be at least one active owner");
    const accessChanged = (patch.role !== undefined && patch.role !== current.role) || (patch.active !== undefined && patch.active !== current.active);
    const user = await tx.adminUser.update({
      where: { id },
      data: { ...(patch.role && { role: patch.role }), ...(patch.active !== undefined && { active: patch.active }), ...(patch.name && { name: patch.name.trim() }), ...(patch.unlock && { failedLogins: 0, lockedUntil: null }) },
      select: publicUser,
    });
    const revoked = accessChanged ? (await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })).count : 0;
    return { ok: true as const, user, sessionsRevoked: revoked };
  });
}

/** Owner resets someone's password (or the bootstrap script resets the owner's). Ends all their sessions and clears any lock. */
export async function resetPassword(id: string, newPassword: string): Promise<UserResult<{ sessionsRevoked: number }>> {
  const u = await db.adminUser.findUnique({ where: { id }, select: { email: true } });
  if (!u) return fail("not_found", "Account not found");
  const problem = passwordProblem(newPassword, u.email);
  if (problem) return fail("weak_password", problem);
  const passwordHash = await hashPassword(newPassword);
  const revoked = await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } });
    return (await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })).count;
  });
  return { ok: true, sessionsRevoked: revoked };
}

/** Self-service change: needs the current password, ends every OTHER session, keeps the one in use. */
export async function changeOwnPassword(id: string, current: string, next: string, keepSessionId: string): Promise<UserResult<{ sessionsRevoked: number }>> {
  const u = await db.adminUser.findUnique({ where: { id }, select: { email: true, passwordHash: true } });
  if (!u) return fail("not_found", "Account not found");
  if (!(await verifyPassword(current, u.passwordHash))) return fail("wrong_password", "Current password is incorrect");
  const problem = passwordProblem(next, u.email);
  if (problem) return fail("weak_password", problem);
  const passwordHash = await hashPassword(next);
  const revoked = await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date() } });
    return (await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null, id: { not: keepSessionId } }, data: { revokedAt: new Date() } })).count;
  });
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
