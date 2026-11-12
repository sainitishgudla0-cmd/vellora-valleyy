import { fail, json } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { findAccountForCustomer } from "@/lib/wholesale/accounts";

export const dynamic = "force-dynamic";

/** The signed-in customer's own business account and its status (never the internal staff note). */
export async function GET(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const a = await findAccountForCustomer(auth.customer);
  if (!a) return fail("No business account", 404);
  return json({ account: { status: a.status, companyName: a.companyName, gstin: a.gstin, contactName: a.contactName, phone: a.phone, paymentTerms: a.paymentTerms, creditLimit: a.paymentTerms === "credit" ? a.creditLimit : null, approvedAt: a.approvedAt, createdAt: a.createdAt } });
}
