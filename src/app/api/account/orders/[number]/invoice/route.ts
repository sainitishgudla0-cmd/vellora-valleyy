import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import type { InvoicePayload } from "@/lib/invoices/payload";

export const dynamic = "force-dynamic";

/** Download the tax invoice of one of YOUR orders. Another customer's order, an uninvoiced order and an unknown number are all the same 404. */
export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const { number } = await params;
  const inv = await db.invoice.findFirst({ where: { order: { number, customerId: auth.customer.customerId } } });
  if (!inv) return fail("Invoice not found", 404);
  const pdf = renderInvoicePdf(JSON.parse(inv.payload) as InvoicePayload);
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${inv.number.replace(/\//g, "-")}.pdf"`, "Cache-Control": "private, no-store" } });
}
