import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { moveQuote, priceQuote } from "@/lib/wholesale/quotes";
import { quoteActionSchema } from "@/lib/wholesale/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const q = await db.quote.findUnique({ where: { id }, include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } }, businessAccount: { select: { id: true, companyName: true, gstin: true, paymentTerms: true } }, order: { select: { number: true } } } });
  if (!q) return fail("Quote not found", 404);
  return json({ quote: { ...q, orderNumber: q.order?.number ?? null, order: undefined } });
}

/** `{ action: "quote", items: [{ variantId, unitPrice }], deliveryFee?, validDays?, buyerNote? }` prices (or re-prices) a quote; `reject` / `cancel` end it. Amounts are paise. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, quoteActionSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const r = body.action === "quote"
    ? await priceQuote(id, { items: body.items, deliveryFee: body.deliveryFee, validDays: body.validDays, buyerNote: body.buyerNote }, auth.admin.actorId)
    : await moveQuote(id, body.action === "reject" ? "rejected" : "cancelled", { type: "admin", id: auth.admin.actorId });
  // ids and the action only: prices and notes live on the quote itself
  await writeAudit({ action: `quote.${body.action}`, outcome: r.ok ? "success" : "rejected", admin: auth.admin, targetType: "quote", targetId: id, details: r.ok ? undefined : { code: r.code } });
  if (r.ok) return json({ ok: true, ...("quote" in r ? { quote: r.quote } : {}) });
  if (r.code === "not_found") return fail(r.message, 404);
  if (r.code === "validation" || r.code === "items_mismatch") return fail(r.message, 422, "fields" in r ? r.fields : undefined);
  return NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
}
