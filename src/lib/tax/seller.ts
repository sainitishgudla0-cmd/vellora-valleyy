import { site } from "@/config/site";
import { validateGstin } from "@/lib/wholesale/gstin";
import { stateCode } from "./states";

/**
 * The supplier on every invoice (M7, ADR 0015). The GSTIN is configuration, not code: SELLER_GSTIN (and optionally
 * SELLER_LEGAL_NAME). It must be a well-formed GSTIN whose state code matches the registered state in `site.address`.
 * Until it is set, orders still work but invoices are refused (`seller_not_configured`).
 */
export interface Seller {
  legalName: string;
  gstin: string;
  address: { line1: string; city: string; state: string; pincode: string };
  stateCode: string;
  fssai: string;
}

export type SellerResult = { ok: true; seller: Seller } | { ok: false; issues: string[] };

export function resolveSeller(env: Record<string, string | undefined> = process.env): SellerResult {
  const issues: string[] = [];
  const raw = env.SELLER_GSTIN?.trim() ?? "";
  const stCode = stateCode(site.address.state);
  if (!stCode) issues.push(`The registered state "${site.address.state}" has no GST state code.`);
  if (!raw) issues.push("SELLER_GSTIN is not set.");
  const g = raw ? validateGstin(raw) : null;
  if (g && !g.ok) issues.push(`SELLER_GSTIN is invalid: ${g.error}.`);
  if (g?.ok && stCode && g.gstin.slice(0, 2) !== stCode) issues.push(`SELLER_GSTIN starts with ${g.gstin.slice(0, 2)} but the registered state ${site.address.state} is ${stCode}.`);
  if (issues.length || !g?.ok || !stCode) return { ok: false, issues };
  return { ok: true, seller: { legalName: env.SELLER_LEGAL_NAME?.trim() || site.company, gstin: g.gstin, address: { line1: site.address.line1, city: site.address.city, state: site.address.state, pincode: site.address.pincode }, stateCode: stCode, fssai: site.fssaiLicense } };
}
