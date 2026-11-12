/**
 * Pure availability rules (M3, ADR 0011). No I/O, safe to import anywhere.
 * A variant is either on the legacy manual flag (`trackInventory = false`, `inStock` decides) or tracked
 * (units on hand minus units reserved for open orders decide, and `inStock` is ignored).
 */
export interface StockFields {
  inStock: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  reserved: number;
}

/** Units that can still be sold, or `null` when the variant is not tracked. */
export function availableUnits(v: Pick<StockFields, "trackInventory" | "stockQuantity" | "reserved">): number | null {
  return v.trackInventory ? Math.max(0, v.stockQuantity - v.reserved) : null;
}

/** The `inStock` value the API exposes: derived for tracked variants, the manual flag otherwise. */
export function effectiveInStock(v: StockFields): boolean {
  return v.trackInventory ? v.stockQuantity - v.reserved > 0 : v.inStock;
}
