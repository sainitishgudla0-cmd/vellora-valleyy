import "server-only";
import type { OrderActorType, Prisma, QuoteStatus } from "@prisma/client";

/**
 * Quote lifecycle (M6-T4, ADR 0014). The only place that moves a quote between statuses:
 *   requested -> quoted | rejected | cancelled
 *   quoted    -> quoted (revised) | accepted | declined | expired | cancelled
 * Everything else is terminal. Only the buyer accepts or declines, only staff prices or rejects, only the system expires.
 * Each move is one conditional UPDATE plus a QuoteEvent in the caller's transaction, so concurrent writers lose cleanly.
 */
export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  requested: ["quoted", "rejected", "cancelled"],
  quoted: ["quoted", "accepted", "declined", "expired", "cancelled"],
  accepted: [],
  declined: [],
  expired: [],
  rejected: [],
  cancelled: [],
};

const TARGET_ACTORS: Partial<Record<QuoteStatus, readonly OrderActorType[]>> = {
  quoted: ["admin"],
  rejected: ["admin"],
  accepted: ["customer"],
  declined: ["customer"],
  expired: ["system"],
  cancelled: ["admin", "customer", "system"],
};

export type QuoteTransitionCode = "invalid_transition" | "actor_not_allowed" | "stale_state";
export type QuoteTransitionResult = { ok: true } | { ok: false; code: QuoteTransitionCode; message: string };

export function validateQuoteTransition(from: QuoteStatus, to: QuoteStatus, actor: OrderActorType): QuoteTransitionResult {
  if (!QUOTE_TRANSITIONS[from]?.includes(to)) return { ok: false, code: "invalid_transition", message: `A quote cannot move from ${from} to ${to}` };
  if (TARGET_ACTORS[to] && !TARGET_ACTORS[to]!.includes(actor)) return { ok: false, code: "actor_not_allowed", message: `${actor} may not move a quote to ${to}` };
  return { ok: true };
}

export async function transitionQuote(
  tx: Prisma.TransactionClient,
  input: { quoteId: string; from: QuoteStatus; to: QuoteStatus; actor: { type: OrderActorType; id?: string }; data?: Prisma.QuoteUpdateManyMutationInput & { orderId?: string } },
): Promise<QuoteTransitionResult> {
  const v = validateQuoteTransition(input.from, input.to, input.actor.type);
  if (!v.ok) return v;
  const r = await tx.quote.updateMany({ where: { id: input.quoteId, status: input.from }, data: { ...input.data, status: input.to } });
  if (r.count !== 1) return { ok: false, code: "stale_state", message: "The quote changed since it was read" };
  await tx.quoteEvent.create({ data: { quoteId: input.quoteId, fromStatus: input.from, toStatus: input.to, actorType: input.actor.type, actorId: input.actor.id ?? null } });
  return { ok: true };
}
