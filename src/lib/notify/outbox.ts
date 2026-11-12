import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notificationsEnabled } from "./provider";

/**
 * Transactional outbox (M7-T5). `enqueueOutbox` runs INSIDE the transaction of the change it announces, so a message exists
 * if and only if the change committed; `dedupeKey` (unique) makes it idempotent. When notifications are off nothing is queued
 * (so no backlog of stale emails can be blasted out when a provider is later switched on).
 */
export interface OutboxInput {
  template: string;
  subjectType: "order" | "quote";
  subjectId: string;
  dedupeKey: string;
}

export async function enqueueOutbox(tx: Prisma.TransactionClient | typeof db, m: OutboxInput): Promise<boolean> {
  if (!notificationsEnabled()) return false;
  const r = await tx.outboxMessage.createMany({ data: [{ channel: "email", template: m.template, subjectType: m.subjectType, subjectId: m.subjectId, dedupeKey: m.dedupeKey }], skipDuplicates: true });
  return r.count === 1;
}
