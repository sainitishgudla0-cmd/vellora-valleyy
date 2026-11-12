/** Pure wholesale rules (M6): price tiers and MOQ / case-pack checks. No I/O. */
export interface PriceTier {
  minQty: number;
  unitPrice: number;
}

/** The tier with the highest `minQty` that the quantity reaches, or null when it reaches none. */
export function pickTier(tiers: readonly PriceTier[], quantity: number): PriceTier | null {
  let best: PriceTier | null = null;
  for (const t of tiers) if (t.minQty <= quantity && (!best || t.minQty > best.minQty)) best = t;
  return best;
}

export interface QuantityTerms {
  moq: number;
  casePack: number;
}

export const NO_RESTRICTION: QuantityTerms = { moq: 1, casePack: 1 };

/** A human reason the quantity is not allowed, or null. */
export function quantityProblem(terms: QuantityTerms, quantity: number): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) return "Quantity must be a whole number of at least 1";
  if (quantity < terms.moq) return `Minimum order is ${terms.moq}`;
  if (terms.casePack > 1 && quantity % terms.casePack !== 0) return `Order in multiples of ${terms.casePack} (case pack)`;
  return null;
}

/** Where the unit price came from: the buyer's price list, or the retail price (never worse than retail by omission). */
export type PriceSource = "list" | "retail";

export function resolveUnitPrice(retailPrice: number, tiers: readonly PriceTier[], quantity: number): { unitPrice: number; source: PriceSource } {
  const tier = pickTier(tiers, quantity);
  return tier ? { unitPrice: tier.unitPrice, source: "list" } : { unitPrice: retailPrice, source: "retail" };
}
