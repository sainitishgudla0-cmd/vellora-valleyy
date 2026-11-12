import "server-only";
import { db } from "@/lib/db";

/**
 * Audit trail for admin logins and mutations (M4-T5, ADR 0012) and privacy-relevant customer actions (M5). Rows are append-only and hold ids and changed field
 * names only: never passwords, tokens, free-text reasons or customer data. A failed audit write is logged (without
 * its contents) and never turns a finished mutation into an error response.
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

export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    const details = e.details ? JSON.stringify(e.details).slice(0, 1000) : null;
    await db.auditLog.create({
      data: {
        action: e.action,
        outcome: e.outcome,
        actorUserId: e.admin?.userId ?? null,
        actorLabel: e.admin?.label ?? "anonymous",
        actorRole: e.admin?.role ?? null,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        details,
      },
    });
  } catch {
    console.error(`[audit] could not record action=${e.action} outcome=${e.outcome}`);
  }
}
