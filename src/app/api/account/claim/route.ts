import { fail, json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { writeAudit } from "@/lib/auth/audit";
import { claimByToken, claimByVerifiedEmail } from "@/lib/account/claim";
import { claimSchema } from "@/lib/account/schemas";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Link past guest orders to this account: `{ "mode": "email" }` (orders placed with your verified email) or
 * `{ orderNumber, token }` (the guest link's token proves the order is yours).
 */
export async function POST(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("account-claim", 20, 15 * 60_000))) return fail("Too many attempts. Please try again later.", 429);
  const parsed = await parseBody(req, claimSchema);
  if ("response" in parsed) return parsed.response;
  const { customerId, email } = auth.customer;
  const actor = { userId: null, label: `customer:${customerId}`, role: "customer" };
  if ("mode" in parsed.data) {
    const claimed = await claimByVerifiedEmail(customerId, email);
    await writeAudit({ action: "customer.claim", outcome: "success", admin: actor, targetType: "customer", targetId: customerId, details: { mode: "email", claimed } });
    return json({ ok: true, claimed });
  }
  const r = await claimByToken(customerId, parsed.data.orderNumber, parsed.data.token);
  await writeAudit({ action: "customer.claim", outcome: r === "not_found" ? "rejected" : "success", admin: actor, targetType: "customer", targetId: customerId, details: { mode: "token", result: r } });
  return r === "not_found" ? fail("We could not find that order with that link.", 404) : json({ ok: true, claimed: r === "claimed" ? 1 : 0 });
}
