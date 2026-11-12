/** Pure invoice helpers (M7-T2, ADR 0015): financial year, numbering and Indian money formatting. */

/** Financial year (April-March) of a moment, by the calendar in India. 2026-04-01 IST starts "2026-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1; // month index 3 = April
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "VV/26-27/000123": at most 16 characters of letters, digits, "/" and "-" (the GST rule for an invoice number). */
export function invoiceNumber(fy: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) throw new RangeError("invoice sequence out of range");
  return `VV/${fy.slice(2)}/${String(seq).padStart(6, "0")}`;
}

/** 123456789 paise -> "12,34,567.89" (Indian digit grouping, always two decimals). */
export function formatInr(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}${grouped}.${frac}`;
}

/** 1800 -> "18%", 250 -> "2.5%" */
export const formatRate = (rateBp: number): string => `${rateBp % 100 === 0 ? rateBp / 100 : (rateBp / 100).toFixed(2).replace(/0$/, "")}%`;
