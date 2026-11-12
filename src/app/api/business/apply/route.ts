import { fail, json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { writeAudit } from "@/lib/auth/audit";
import { applyForBusinessAccount } from "@/lib/wholesale/accounts";
import { failure } from "@/lib/wholesale/http";
import { applySchema } from "@/lib/wholesale/schemas";
import { rateLimit } from "@/lib/rate-limit";

/** Apply for a business (wholesale) account. Signed-in customers only (their email is verified); staff approve. GSTIN format and check character are validated. */
export async function POST(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("business-apply", 5, 60 * 60_000))) return fail("Too many attempts. Please try again later.", 429);
  const parsed = await parseBody(req, applySchema);
  if ("response" in parsed) return parsed.response;
  const r = await applyForBusinessAccount(auth.customer, parsed.data);
  await writeAudit({ action: "business.apply", outcome: r.ok ? "success" : "rejected", admin: { userId: null, label: `customer:${auth.customer.customerId}`, role: "customer" }, targetType: "business_account", targetId: r.ok ? r.account.id : undefined, details: r.ok ? undefined : { code: r.code } });
  if (!r.ok) return failure(r);
  return json({ account: { status: r.account.status, companyName: r.account.companyName, gstin: r.account.gstin } }, 201);
}
