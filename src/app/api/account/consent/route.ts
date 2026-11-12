import { json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { writeAudit } from "@/lib/auth/audit";
import { setMarketingConsent } from "@/lib/account/profile";
import { consentSchema } from "@/lib/account/schemas";

/** Grant or withdraw marketing consent. Every change is appended to the consent history. */
export async function POST(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, consentSchema);
  if ("response" in parsed) return parsed.response;
  const { customerId } = auth.customer;
  const changed = await setMarketingConsent(customerId, parsed.data.marketing);
  if (changed) await writeAudit({ action: "customer.consent", outcome: "success", admin: { userId: null, label: `customer:${customerId}`, role: "customer" }, targetType: "customer", targetId: customerId, details: { marketing: parsed.data.marketing } });
  return json({ ok: true, marketing: parsed.data.marketing, changed });
}
