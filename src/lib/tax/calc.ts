/**
 * GST arithmetic (M7-T1, ADR 0015). Pure, integer paise only, no floating point in any stored amount.
 *
 * Retail and quoted prices are GST-INCLUSIVE (the brochure MRP includes all taxes), so tax is carved out of the amount:
 *   tax     = round-half-up( amount x rate / (100% + rate) )
 *   taxable = amount - tax
 * Rounding happens once per line (not per unit, not on the grand total), so every line, and therefore the invoice, is exact:
 *   taxable + cgst + sgst + igst = amount, always.
 * Intra-state supply (seller state = place of supply): CGST = floor(tax / 2), SGST = tax - CGST (SGST takes an odd paisa).
 * Inter-state supply: IGST = tax.
 */
export type SupplyType = "intra" | "inter";

export interface TaxSplit {
  rateBp: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

const DENOM = 10_000;

export function splitInclusive(amount: number, rateBp: number, supply: SupplyType): TaxSplit {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError("amount must be a non-negative integer (paise)");
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 5000) throw new RangeError("rateBp must be an integer between 0 and 5000");
  const d = DENOM + rateBp;
  const tax = Math.floor((amount * rateBp * 2 + d) / (2 * d)); // round half up of amount * rateBp / d
  const taxableValue = amount - tax;
  if (supply === "inter") return { rateBp, taxableValue, cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { rateBp, taxableValue, cgst, sgst: tax - cgst, igst: 0 };
}

export const supplyTypeFor = (sellerStateCode: string, buyerStateCode: string | null): SupplyType => (buyerStateCode !== null && buyerStateCode === sellerStateCode ? "intra" : "inter");

export const sumSplits = (parts: readonly Pick<TaxSplit, "taxableValue" | "cgst" | "sgst" | "igst">[]) =>
  parts.reduce((t, p) => ({ taxableValue: t.taxableValue + p.taxableValue, cgst: t.cgst + p.cgst, sgst: t.sgst + p.sgst, igst: t.igst + p.igst }), { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 });
