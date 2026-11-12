/**
 * Test-only admin fixtures: real accounts and real sessions (no mocks), so route tests exercise the same
 * authentication and authorisation path production uses. Never imported by application code.
 */
import type { AdminRole } from "@prisma/client";
import { vi } from "vitest";
import { db } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/auth/admin";
import { createUser } from "@/lib/auth/users";

export const TEST_ADMIN_PASSWORD = "correct horse battery staple 42";
export const FIXTURE_EMAIL_DOMAIN = "m4-fixture.example.com";
let seq = 0;
const tag = Date.now().toString(36);

/** Session signing needs SESSION_SECRET; CI and verify:full set it, a bare local run gets a fake one. */
export function ensureSessionSecret() {
  if ((process.env.SESSION_SECRET ?? "").length < 24) vi.stubEnv("SESSION_SECRET", "test-only-session-secret-0123456789abcdef");
}

export async function createTestAdmin(role: AdminRole = "owner", over: { email?: string; name?: string } = {}) {
  ensureSessionSecret();
  const email = over.email ?? `${role}-${tag}-${++seq}@${FIXTURE_EMAIL_DOMAIN}`;
  const r = await createUser({ email, name: over.name ?? `Fixture ${role}`, role, password: TEST_ADMIN_PASSWORD });
  if (!r.ok) throw new Error(`fixture admin: ${r.message}`);
  const token = await createSession({ userId: r.user.id });
  const session = await db.adminSession.findFirstOrThrow({ where: { userId: r.user.id }, orderBy: { createdAt: "desc" } });
  return { user: r.user, email, password: TEST_ADMIN_PASSWORD, token, cookie: `${SESSION_COOKIE}=${token}`, sessionId: session.id };
}

export async function createLegacySession() {
  ensureSessionSecret();
  const token = await createSession({ legacy: true });
  return { token, cookie: `${SESSION_COOKIE}=${token}` };
}

export async function cleanupAdminFixtures() {
  const users = await db.adminUser.findMany({ where: { email: { endsWith: `@${FIXTURE_EMAIL_DOMAIN}` } }, select: { id: true } });
  await db.adminSession.deleteMany({ where: { OR: [{ legacy: true }, { userId: { in: users.map((u) => u.id) } }] } }); // cascade would also do the users' ones
  await db.adminUser.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.auditLog.deleteMany({});
}
