import { fail, json, parseBody } from "@/lib/api";
import { log, errorName } from "@/lib/log";
import { writeAudit } from "@/lib/auth/audit";
import { requireBusiness } from "@/lib/wholesale/auth";
import { failure, orderFailure } from "@/lib/wholesale/http";
import { acceptQuote } from "@/lib/wholesale/quotes";
import { quoteAcceptSchema } from "@/lib/wholesale/schemas";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Accept a quoted price: body is the delivery details. Creates the order at EXACTLY the quoted prices (stock held, credit
 * limit checked) and marks the quote accepted in one transaction. Expired quotes are refused (409 quote_expired).
 */
export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("business-quote-accept", 20, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);
  const { number } = await params;
  const parsed = await parseBody(req, quoteAcceptSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const r = await acceptQuote(auth.account, auth.customer.customerId, number, parsed.data);
    await writeAudit({ action: "quote.accept", outcome: r.ok ? "success" : "rejected", admin: { userId: null, label: `customer:${auth.customer.customerId}`, role: "customer" }, targetType: "quote", targetId: number, details: r.ok ? { order: r.order.number } : { code: r.code } });
    return r.ok ? json({ order: r.order }, 201) : failure(r);
  } catch (e) {
    const o = orderFailure(e);
    if (o) return o;
    log.error("business.quote_accept_failed", { errorName: errorName(e) });
    return fail("Something went wrong while placing your order. Please try again.", 500);
  }
}
