import "server-only";
import type { BusinessAccount } from "@prisma/client";
import { requireCustomer, type CustomerContext } from "@/lib/auth/customer";
import { findAccountForCustomer } from "./accounts";

/**
 * Gate for /api/business/* (M6). Signed-in customer first (401, same-origin check), then an APPROVED business account (403).
 * Retail customers, applicants whose account is pending/rejected/suspended/closed, and everyone else get 403 and no data.
 */
export async function requireBusiness(req: Request): Promise<{ customer: CustomerContext; account: BusinessAccount } | { response: Response }> {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth;
  const account = await findAccountForCustomer(auth.customer);
  if (!account) return { response: Response.json({ error: "A business account is required", code: "business_account_required" }, { status: 403 }) };
  if (account.status !== "approved") return { response: Response.json({ error: "Your business account is not active", code: "business_account_not_active", status: account.status }, { status: 403 }) };
  return { customer: auth.customer, account };
}
