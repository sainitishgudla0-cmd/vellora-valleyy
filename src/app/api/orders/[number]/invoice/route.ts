import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail } from "@/lib/api";
import { safeEqual } from "@/lib/payment-verification";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import type { InvoicePayload } from "@/lib/invoices/payload";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Tax invoice PDF for a guest or signed-in shopper who holds the order's access token (the same `t` the order page uses, M8-T4).
 * A wrong token, an uninvoiced order and an unknown order number are all the same 404. The response is never cached or referred on.
 */
export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  if (!(await rateLimit("order-invoice", 30, 10 * 60_000))) return fail("Too many requests. Please try again later.", 429);
  const { number } = await params;
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const order = await db.order.findUnique({ where: { number }, select: { accessToken: true, invoice: true } });
  if (!order || !order.invoice || !token || !safeEqual(token, order.accessToken)) return fail("Invoice not found", 404);
  const pdf = renderInvoicePdf(JSON.parse(order.invoice.payload) as InvoicePayload);
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${order.invoice.number.replace(/\//g, "-")}.pdf"`, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}
