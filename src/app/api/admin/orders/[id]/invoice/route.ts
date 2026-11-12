import { NextResponse } from "next/server";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { issueInvoice } from "@/lib/invoices/issue";

/**
 * Issue the tax invoice for an order (confirmed, paid, dispatched or delivered). Idempotent: an order has at most one invoice and a
 * repeat returns it (200). `409 seller_not_configured` / `tax_not_configured` list what is missing; nothing is issued with a guessed rate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const r = await issueInvoice(id);
  await writeAudit({ action: "invoice.issue", outcome: r.ok ? (r.created ? "success" : "rejected") : "rejected", admin: auth.admin, targetType: "order", targetId: id, details: r.ok ? { number: r.invoice.number, created: r.created } : { code: r.code } });
  if (r.ok) return json({ invoice: { id: r.invoice.id, number: r.invoice.number, issuedAt: r.invoice.issuedAt, total: r.invoice.total, supplyType: r.invoice.supplyType } }, r.created ? 201 : 200);
  if (r.code === "not_found") return fail(r.message, 404);
  return NextResponse.json({ error: r.message, code: r.code, detail: r.detail }, { status: 409 });
}
