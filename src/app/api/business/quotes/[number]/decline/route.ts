import { fail, json } from "@/lib/api";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/auth/audit";
import { requireBusiness } from "@/lib/wholesale/auth";
import { failure } from "@/lib/wholesale/http";
import { moveQuote } from "@/lib/wholesale/quotes";

/** Decline a quoted price. */
export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  const { number } = await params;
  const q = await db.quote.findFirst({ where: { number, businessAccountId: auth.account.id }, select: { id: true } });
  if (!q) return fail("Quote not found", 404);
  const r = await moveQuote(q.id, "declined", { type: "customer", id: auth.customer.customerId }, { accountId: auth.account.id });
  await writeAudit({ action: "quote.decline", outcome: r.ok ? "success" : "rejected", admin: { userId: null, label: `customer:${auth.customer.customerId}`, role: "customer" }, targetType: "quote", targetId: number, details: r.ok ? undefined : { code: r.code } });
  return r.ok ? json({ ok: true }) : failure(r);
}
