import { json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { listPaymentExceptions } from "@/lib/ops/readiness";

export const dynamic = "force-dynamic";

/**
 * Money that needs a person (M11): captured payments that could not be applied (refund them), attempts awaiting
 * reconciliation, refunds pending over an hour or failed in the last 30 days. Order numbers and amounts only, no customer
 * contact data. Owners act through POST /api/admin/orders/[id]/refunds. Contract: docs/API-CONTRACTS.md.
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  return json({ exceptions: await listPaymentExceptions() });
}
