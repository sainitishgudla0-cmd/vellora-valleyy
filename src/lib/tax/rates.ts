import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { splitInclusive, type SupplyType, type TaxSplit } from "./calc";

type Client = Prisma.TransactionClient | typeof db;

export const DELIVERY_CODE = "DELIVERY";

/** The codes to look up for an HSN, most specific first: the full code, then its 6- and 4-digit parents. */
export const hsnCandidates = (hsn: string): string[] => [...new Set([hsn, hsn.slice(0, 6), hsn.slice(0, 4)].filter((c) => c.length >= 4))];

/** Date (UTC midnight of the calendar day in India) a rate lookup is made "as of". */
export const asOfDay = (d: Date): Date => new Date(new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) + "T00:00:00.000Z");

/**
 * Rate (basis points) in force on `asOf` for each requested code. For an HSN the most specific configured code wins; within
 * it the latest `effectiveFrom` not after `asOf`. Codes with no configured rate are absent from the map (never guessed).
 */
export async function resolveRates(client: Client, hsns: string[], includeDelivery: boolean, asOf: Date): Promise<Map<string, number>> {
  const wanted = new Set<string>(hsns.flatMap(hsnCandidates));
  if (includeDelivery) wanted.add(DELIVERY_CODE);
  if (wanted.size === 0) return new Map();
  const day = asOfDay(asOf);
  const rows = await client.taxRate.findMany({ where: { code: { in: [...wanted] }, effectiveFrom: { lte: day } }, orderBy: { effectiveFrom: "desc" } });
  const latest = new Map<string, number>();
  for (const r of rows) if (!latest.has(r.code)) latest.set(r.code, r.rateBp);
  const out = new Map<string, number>();
  for (const h of hsns) for (const c of hsnCandidates(h)) if (latest.has(c)) { out.set(h, latest.get(c)!); break; }
  if (includeDelivery && latest.has(DELIVERY_CODE)) out.set(DELIVERY_CODE, latest.get(DELIVERY_CODE)!);
  return out;
}

export interface OrderTaxInput {
  supply: SupplyType;
  lines: { hsCode: string | null; amount: number }[];
  deliveryFee: number;
  asOf: Date;
}

export interface OrderTaxSnapshot {
  lines: (TaxSplit | null)[];
  /** null when there is no delivery fee to tax, or no DELIVERY rate is configured */
  delivery: TaxSplit | null;
  /** HSN codes (and DELIVERY) that had no configured rate */
  missing: string[];
}

export async function snapshotOrderTax(client: Client, input: OrderTaxInput): Promise<OrderTaxSnapshot> {
  const hsns = [...new Set(input.lines.map((l) => l.hsCode).filter((h): h is string => !!h))];
  const rates = await resolveRates(client, hsns, input.deliveryFee > 0, input.asOf);
  const missing = new Set<string>();
  const lines = input.lines.map((l) => {
    const rate = l.hsCode ? rates.get(l.hsCode) : undefined;
    if (rate === undefined) {
      missing.add(l.hsCode ?? "(no HSN)");
      return null;
    }
    return splitInclusive(l.amount, rate, input.supply);
  });
  let delivery: TaxSplit | null = null;
  if (input.deliveryFee > 0) {
    const r = rates.get(DELIVERY_CODE);
    if (r === undefined) missing.add(DELIVERY_CODE);
    else delivery = splitInclusive(input.deliveryFee, r, input.supply);
  }
  return { lines, delivery, missing: [...missing] };
}
