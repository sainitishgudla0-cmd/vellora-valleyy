import { json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { collectReadiness } from "@/lib/ops/readiness";

export const dynamic = "force-dynamic";

/** Launch readiness and operational exceptions (M11). Read-only; never returns secrets, only whether they are set. Contract: docs/API-CONTRACTS.md. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  return json(await collectReadiness());
}
