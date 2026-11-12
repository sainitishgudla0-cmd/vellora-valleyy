import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import type { InvoicePayload } from "@/lib/invoices/payload";

export const dynamic = "force-dynamic";

/** The invoice as a PDF (default) or its frozen JSON (`?format=json`). Always rendered from the stored payload, so it is identical every time. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const inv = await db.invoice.findUnique({ where: { id } });
  if (!inv) return fail("Invoice not found", 404);
  const payload = JSON.parse(inv.payload) as InvoicePayload;
  if (new URL(req.url).searchParams.get("format") === "json") return json({ invoice: payload });
  return new NextResponse(new Uint8Array(renderInvoicePdf(payload)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${inv.number.replace(/\//g, "-")}.pdf"`, "Cache-Control": "private, no-store" } });
}
