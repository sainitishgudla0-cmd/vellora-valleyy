import { NextResponse } from "next/server";
import { fail } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { writeAudit } from "@/lib/auth/audit";
import { exportCustomerData } from "@/lib/account/erasure";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Download everything held about you as JSON (DPDP Act 2023). */
export async function GET(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("account-export", 5, 60 * 60_000))) return fail("Too many requests. Please try again later.", 429);
  const data = await exportCustomerData(auth.customer.customerId);
  if (!data) return fail("Please sign in", 401);
  await writeAudit({ action: "customer.export", outcome: "success", admin: { userId: null, label: `customer:${auth.customer.customerId}`, role: "customer" }, targetType: "customer", targetId: auth.customer.customerId });
  return new NextResponse(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="velora-valley-my-data.json"', "Cache-Control": "no-store" } });
}
