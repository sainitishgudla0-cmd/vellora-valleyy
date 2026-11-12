import { NextResponse } from "next/server";
import { fail, parseBody } from "@/lib/api";
import { CUSTOMER_COOKIE, requireCustomer } from "@/lib/auth/customer";
import { writeAudit } from "@/lib/auth/audit";
import { eraseCustomer } from "@/lib/account/erasure";
import { deleteAccountSchema } from "@/lib/account/schemas";

/** A sign-in newer than this is required to delete the account (a stolen old session cannot erase it). */
export const RECENT_SIGN_IN_MS = 10 * 60_000;

/**
 * Delete the account (DPDP Act 2023). Needs `{ "confirm": "DELETE" }` and a sign-in from the last 10 minutes. Refused (409)
 * while any order is still in progress. Orders are anonymised, not deleted (see src/lib/account/erasure.ts).
 */
export async function DELETE(req: Request) {
  const auth = await requireCustomer(req, { recentMs: RECENT_SIGN_IN_MS });
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, deleteAccountSchema);
  if ("response" in parsed) return parsed.response;
  const { customerId } = auth.customer;
  const r = await eraseCustomer(customerId);
  // the audit row names only the opaque id, which no longer points at anything
  await writeAudit({ action: "customer.delete", outcome: r.ok ? "success" : "rejected", admin: { userId: null, label: `customer:${customerId}`, role: "customer" }, details: r.ok ? { ordersAnonymised: r.ordersAnonymised } : { code: r.code } });
  if (!r.ok) return r.code === "not_found" ? fail(r.message, 404) : NextResponse.json({ error: r.message, code: r.code, openOrders: r.openOrders }, { status: 409 });
  const res = NextResponse.json({ ok: true, ordersAnonymised: r.ordersAnonymised });
  res.cookies.delete(CUSTOMER_COOKIE);
  return res;
}
