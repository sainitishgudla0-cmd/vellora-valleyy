import "server-only";
import { log } from "@/lib/log";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Audit trail for admin logins and mutations (M4-T5, ADR 0012) and privacy-relevant customer actions (M5). Rows are append-only and hold ids and changed field
 * names only: never passwords, tokens, free-text reasons or customer data.
 *
 * Two classes (M11 P1-T4, finding F07, ADR 0021):
 *  - CRITICAL successes (money, payment state, accounts, roles, credentials; `CRITICAL_AUDIT_ACTIONS`) are written with
 *    `writeAuditTx` inside the transaction that makes the change. If the audit row cannot be written the change rolls
 *    back: no critical mutation exists without its evidence.
 *  - Everything else (rejections, denials, logins, catalogue and fulfilment edits) uses `writeAudit`: best-effort, a
 *    failed write is logged without its contents and never turns a finished mutation into an error response.
 */
export type AuditOutcome = "success" | "rejected" | "denied" | "failed";

export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  /** the acting admin, or `{ userId: null, label: "customer:<id>", role: "customer" }` for a customer-initiated change */
  admin?: { userId: string | null; label: string; role: string } | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/** Actions whose successful outcome is only ever recorded in the same transaction as the change (`writeAuditTx`). */
export const CRITICAL_AUDIT_ACTIONS = ["order.update", "order.refund.requested", "user.create", "user.update", "user.password_reset", "password.change", "owner.recover"] as const;
export type CriticalAuditAction = (typeof CRITICAL_AUDIT_ACTIONS)[number];

/** Who performed a critical change: an admin context, or a named operator script (e.g. `admin:bootstrap`). */
export type AuditActor = NonNullable<AuditEntry["admin"]>;

const auditRow = (e: AuditEntry) => ({
  action: e.action,
  outcome: e.outcome,
  actorUserId: e.admin?.userId ?? null,
  actorLabel: e.admin?.label ?? "anonymous",
  actorRole: e.admin?.role ?? null,
  targetType: e.targetType ?? null,
  targetId: e.targetId ?? null,
  details: e.details ? JSON.stringify(e.details).slice(0, 1000) : null,
});

/**
 * Fail-closed audit for a critical change: written with the caller's transaction client and NEVER swallowed, so a
 * failed insert aborts the transaction (and the change). Only `success` outcomes of `CRITICAL_AUDIT_ACTIONS` belong here.
 */
export async function writeAuditTx(tx: Prisma.TransactionClient, e: AuditEntry & { action: CriticalAuditAction; outcome: "success"; admin: AuditActor }): Promise<void> {
  await tx.auditLog.create({ data: auditRow(e) });
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({ data: auditRow(e) });
  } catch {
    log.error("audit.write_failed", { action: e.action, outcome: e.outcome });
  }
}
