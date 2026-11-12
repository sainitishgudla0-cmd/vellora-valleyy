import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { site } from "@/config/site";

/**
 * Pincode serviceability and delivery fee (M7-T3, ADR 0015).
 *  - NO active rules: legacy behaviour (every pincode accepted, fee = `site.delivery.fee`). Nothing changes until staff add a rule.
 *  - Any active rule: an order's pincode needs a matching rule. The longest matching prefix wins; an empty prefix is the catch-all.
 *    A rule can mark an area unserviceable, charge a fee, and waive it above a subtotal. No match = not serviceable.
 */
export interface RuleLike {
  id: string;
  pincodePrefix: string;
  serviceable: boolean;
  fee: number;
  freeAboveSubtotal: number | null;
}

export interface ShippingQuote {
  serviceable: boolean;
  /** paise (0 when unserviceable) */
  fee: number;
  /** the subtotal (paise) from which the fee is waived, if the matching rule has one */
  freeAboveSubtotal: number | null;
  ruleId: string | null;
  /** true when no rules exist and the site default applies */
  legacy: boolean;
}

export function matchRule<T extends Pick<RuleLike, "pincodePrefix">>(rules: readonly T[], pincode: string): T | null {
  let best: T | null = null;
  for (const r of rules) if (pincode.startsWith(r.pincodePrefix) && (!best || r.pincodePrefix.length > best.pincodePrefix.length)) best = r;
  return best;
}

export function quoteFromRules(rules: readonly RuleLike[], pincode: string, subtotal: number): ShippingQuote {
  if (rules.length === 0) return { serviceable: true, fee: site.delivery.fee, freeAboveSubtotal: null, ruleId: null, legacy: true };
  const r = matchRule(rules, pincode);
  if (!r || !r.serviceable) return { serviceable: false, fee: 0, freeAboveSubtotal: null, ruleId: r?.id ?? null, legacy: false };
  const waived = r.freeAboveSubtotal !== null && subtotal >= r.freeAboveSubtotal;
  return { serviceable: true, fee: waived ? 0 : r.fee, freeAboveSubtotal: r.freeAboveSubtotal, ruleId: r.id, legacy: false };
}

export async function quoteShipping(client: Prisma.TransactionClient | typeof db, pincode: string, subtotal: number): Promise<ShippingQuote> {
  const rules = await client.shippingRule.findMany({ where: { active: true }, select: { id: true, pincodePrefix: true, serviceable: true, fee: true, freeAboveSubtotal: true } });
  return quoteFromRules(rules, pincode, subtotal);
}
