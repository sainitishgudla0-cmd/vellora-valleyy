import { formatRate } from "./format";
import type { SupplyType, TaxSplit } from "@/lib/tax/calc";
import { sumSplits } from "@/lib/tax/calc";
import type { Seller } from "@/lib/tax/seller";

/**
 * The frozen content of an invoice (M7-T2). Built once at issue time and stored; the PDF is a pure function of it, so an
 * invoice regenerates byte-for-byte and later changes to the catalogue, rates or seller settings cannot alter an issued invoice.
 */
export interface InvoiceLine {
  description: string;
  hsCode: string;
  quantity: number;
  /** GST-inclusive unit price, paise */
  unitPrice: number;
  rateBp: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** GST-inclusive line total, paise */
  total: number;
}

export interface InvoicePayload {
  version: 1;
  number: string;
  issuedAt: string;
  financialYear: string;
  supplyType: SupplyType;
  seller: Seller;
  buyer: { name: string; company: string | null; gstin: string | null; line1: string; line2: string | null; city: string; state: string; stateCode: string | null; pincode: string };
  order: { number: string; placedAt: string };
  placeOfSupply: { state: string; stateCode: string | null };
  lines: InvoiceLine[];
  delivery: (TaxSplit & { description: string; total: number }) | null;
  totals: { taxableValue: number; cgst: number; sgst: number; igst: number; total: number };
  reverseCharge: false;
}

export interface BuildInput {
  number: string;
  issuedAt: Date;
  financialYear: string;
  supplyType: SupplyType;
  seller: Seller;
  order: { number: string; createdAt: Date; customerName: string; addressLine1: string; addressLine2: string | null; city: string; state: string; pincode: string };
  business: { companyName: string; gstin: string } | null;
  buyerStateCode: string | null;
  lines: { productName: string; variantLabel: string; hsCode: string; quantity: number; unitPrice: number; lineTotal: number; split: TaxSplit }[];
  deliveryFee: number;
  deliverySplit: TaxSplit | null;
}

export function buildInvoicePayload(i: BuildInput): InvoicePayload {
  const lines: InvoiceLine[] = i.lines.map((l) => ({
    description: `${l.productName} (${l.variantLabel})`,
    hsCode: l.hsCode,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    rateBp: l.split.rateBp,
    taxableValue: l.split.taxableValue,
    cgst: l.split.cgst,
    sgst: l.split.sgst,
    igst: l.split.igst,
    total: l.lineTotal,
  }));
  const delivery = i.deliveryFee > 0 && i.deliverySplit ? { ...i.deliverySplit, description: "Delivery charges", total: i.deliveryFee } : null;
  const sums = sumSplits([...lines, ...(delivery ? [delivery] : [])]);
  return {
    version: 1,
    number: i.number,
    issuedAt: i.issuedAt.toISOString(),
    financialYear: i.financialYear,
    supplyType: i.supplyType,
    seller: i.seller,
    buyer: { name: i.order.customerName, company: i.business?.companyName ?? null, gstin: i.business?.gstin ?? null, line1: i.order.addressLine1, line2: i.order.addressLine2, city: i.order.city, state: i.order.state, stateCode: i.buyerStateCode, pincode: i.order.pincode },
    order: { number: i.order.number, placedAt: i.order.createdAt.toISOString() },
    placeOfSupply: { state: i.order.state, stateCode: i.buyerStateCode },
    lines,
    delivery,
    totals: { ...sums, total: sums.taxableValue + sums.cgst + sums.sgst + sums.igst },
    reverseCharge: false,
  };
}

export const describeRate = (l: { rateBp: number }) => formatRate(l.rateBp);
