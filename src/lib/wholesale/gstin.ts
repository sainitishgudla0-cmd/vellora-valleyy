/**
 * GSTIN validation (M6-T1). Pure. A GSTIN is 15 characters: 2-digit state code, the holder's 10-character PAN,
 * an entity number, a fixed `Z`, and a check character computed from the first 14 (mod-36 weighted sum).
 * This proves the number is well formed, not that the registration exists or is active (that is a GSTN lookup, out of scope).
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FORMAT = /^(0[1-9]|[1-2][0-9]|3[0-8]|9[79])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const normalizeGstin = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck = { ok: true; gstin: string } | { ok: false; error: string };

export function validateGstin(input: string): GstinCheck {
  const g = normalizeGstin(input);
  if (g.length !== 15) return { ok: false, error: "A GSTIN has 15 characters" };
  if (!FORMAT.test(g)) return { ok: false, error: "This does not look like a valid GSTIN" };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, error: "The GSTIN check character is wrong — please re-check the number" };
  return { ok: true, gstin: g };
}
