import "server-only";
import { Prisma, type Invoice } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueOutbox } from "@/lib/notify/outbox";
import { supplyTypeFor, type SupplyType, type TaxSplit } from "@/lib/tax/calc";
import { snapshotOrderTax } from "@/lib/tax/rates";
import { resolveSeller } from "@/lib/tax/seller";
import { stateCode } from "@/lib/tax/states";
import { financialYear, invoiceNumber } from "./format";
import { buildInvoicePayload } from "./payload";

/**
 * Issuing a tax invoice (M7-T2, ADR 0015). One transaction: allocate the next number of the financial year (a row-locked counter, so
 * numbers are gap-free: a failure after allocation rolls the counter back with everything else), freeze the content into
 * `Invoice.payload`, and queue the "invoice issued" notification. One invoice per order (unique); re-issuing returns the same one.
 *
 * Tax comes from the order's own snapshot where it has one. Lines without a snapshot (no rate was configured when the order was
 * placed, or the order pre-dates M7) are computed from the rates in force on the ORDER's date; if any rate is still missing the
 * invoice is refused (`tax_not_configured`, listing the codes), never issued with a guessed rate.
 */
export const INVOICEABLE_STATUSES = ["confirmed", "paid", "dispatched", "delivered"] as const;

export type IssueErrorCode = "not_found" | "order_not_invoiceable" | "seller_not_configured" | "tax_not_configured" | "unsupported_state";
export type IssueResult =
  | { ok: true; invoice: Invoice; created: boolean }
  | { ok: false; code: IssueErrorCode; message: string; detail?: string[] };
const fail = (code: IssueErrorCode, message: string, detail?: string[]): { ok: false; code: IssueErrorCode; message: string; detail?: string[] } => ({ ok: false, code, message, detail });

export async function issueInvoice(orderId: string, now = new Date()): Promise<IssueResult> {
  const seller = resolveSeller();
  if (!seller.ok) return fail("seller_not_configured", "The seller's GST details are not configured", seller.issues);
  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { orderBy: { id: "asc" }, include: { variant: { select: { hsCode: true } } } }, businessAccount: { select: { companyName: true, gstin: true } }, invoice: true } });
      if (!order) return fail("not_found", "Order not found");
      if (order.invoice) return { ok: true as const, invoice: order.invoice, created: false };
      if (!(INVOICEABLE_STATUSES as readonly string[]).includes(order.status)) return fail("order_not_invoiceable", `An order that is ${order.status} cannot be invoiced`);

      const buyerCode = stateCode(order.state);
      if (!buyerCode) return fail("unsupported_state", `No GST state code for "${order.state}"`);
      const supply: SupplyType = (order.supplyType as SupplyType | null) ?? supplyTypeFor(seller.seller.stateCode, buyerCode);

      // Lines: the order's own snapshot, else computed from the rates in force when the order was placed.
      // (Orders that pre-date M7 have no HSN snapshot on their lines: the variant's current HSN is used.)
      const hsnOf = (i: (typeof order.items)[number]) => i.hsCode ?? i.variant.hsCode ?? null;
      const computed = await snapshotOrderTax(tx, { supply, lines: order.items.map((i) => ({ hsCode: hsnOf(i), amount: i.lineTotal })), deliveryFee: order.deliveryGstRateBp === null ? order.deliveryFee : 0, asOf: order.createdAt });
      const lines: { productName: string; variantLabel: string; hsCode: string; quantity: number; unitPrice: number; lineTotal: number; split: TaxSplit }[] = [];
      const missing = new Set<string>();
      order.items.forEach((i, idx) => {
        const hsn = hsnOf(i);
        const own: TaxSplit | null = i.gstRateBp !== null ? { rateBp: i.gstRateBp, taxableValue: i.taxableValue!, cgst: i.cgst!, sgst: i.sgst!, igst: i.igst! } : computed.lines[idx];
        if (!own || !hsn) {
          missing.add(hsn ?? i.sku);
          return;
        }
        lines.push({ productName: i.productName, variantLabel: i.variantLabel, hsCode: hsn, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal, split: own });
      });
      let deliverySplit: TaxSplit | null = null;
      if (order.deliveryFee > 0) {
        deliverySplit = order.deliveryGstRateBp !== null ? { rateBp: order.deliveryGstRateBp, taxableValue: order.deliveryTaxable!, cgst: order.deliveryCgst!, sgst: order.deliverySgst!, igst: order.deliveryIgst! } : computed.delivery;
        if (!deliverySplit) missing.add("DELIVERY");
      }
      if (missing.size) return fail("tax_not_configured", "A GST rate is not configured for some items", [...missing]);

      const fy = financialYear(now);
      const rows = await tx.$queryRaw<{ lastSeq: number }[]>(Prisma.sql`
        INSERT INTO "InvoiceSeries" ("financialYear", "lastSeq") VALUES (${fy}, 1)
        ON CONFLICT ("financialYear") DO UPDATE SET "lastSeq" = "InvoiceSeries"."lastSeq" + 1
        RETURNING "lastSeq"`);
      const seq = rows[0].lastSeq;
      const number = invoiceNumber(fy, seq);
      const payload = buildInvoicePayload({ number, issuedAt: now, financialYear: fy, supplyType: supply, seller: seller.seller, order, business: order.businessAccount, buyerStateCode: buyerCode, lines, deliveryFee: order.deliveryFee, deliverySplit });
      const invoice = await tx.invoice.create({
        data: {
          number, financialYear: fy, seq, orderId, issuedAt: now, supplyType: supply,
          taxableTotal: payload.totals.taxableValue, cgstTotal: payload.totals.cgst, sgstTotal: payload.totals.sgst, igstTotal: payload.totals.igst, total: payload.totals.total,
          buyerGstin: payload.buyer.gstin, payload: JSON.stringify(payload),
        },
      });
      await enqueueOutbox(tx, { template: "invoice_issued", subjectType: "order", subjectId: orderId, dedupeKey: `invoice:${invoice.id}` });
      return { ok: true as const, invoice, created: true };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes("orderId")) {
      const existing = await db.invoice.findUnique({ where: { orderId } }); // a parallel request issued it first
      if (existing) return { ok: true, invoice: existing, created: false };
    }
    throw e;
  }
}
