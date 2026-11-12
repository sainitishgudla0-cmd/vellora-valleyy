import { fail, json } from "@/lib/api";
import { db } from "@/lib/db";
import { requireBusiness } from "@/lib/wholesale/auth";
import { failure } from "@/lib/wholesale/http";
import { getBuyerQuote, moveQuote } from "@/lib/wholesale/quotes";

export const dynamic = "force-dynamic";

/** Another account's quote number answers exactly like an unknown one (404). */
export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  const { number } = await params;
  const q = await getBuyerQuote(auth.account.id, number);
  return q ? json({ quote: q }) : fail("Quote not found", 404);
}

/** Withdraw a quote request (before it is accepted). */
export async function DELETE(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  const { number } = await params;
  const q = await db.quote.findFirst({ where: { number, businessAccountId: auth.account.id }, select: { id: true } });
  if (!q) return fail("Quote not found", 404);
  const r = await moveQuote(q.id, "cancelled", { type: "customer", id: auth.customer.customerId }, { accountId: auth.account.id });
  return r.ok ? json({ ok: true }) : failure(r);
}
