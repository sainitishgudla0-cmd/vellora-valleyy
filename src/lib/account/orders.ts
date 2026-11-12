import "server-only";
import { db } from "@/lib/db";

/**
 * A customer's own orders (M5-T3). Everything is filtered by `customerId` in the query itself: another customer's order
 * is indistinguishable from a missing one (404), and the guest access token, gateway ids and staff-written event
 * reasons are never returned.
 */
export const MAX_PAGE = 50;

export interface OrderSummary {
  number: string;
  createdAt: Date;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  total: number;
  itemCount: number;
}

export async function listOrders(customerId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ orders: OrderSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_PAGE);
  let where: object = { customerId };
  if (opts.cursor) {
    const [iso, id] = opts.cursor.split("_");
    const at = new Date(iso);
    if (!id || Number.isNaN(at.getTime())) throw new RangeError("bad cursor");
    where = { customerId, OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
  }
  const rows = await db.order.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: { items: { select: { quantity: true } } } });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    orders: page.map((o) => ({ number: o.number, createdAt: o.createdAt, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, total: o.total, itemCount: o.items.reduce((s, i) => s + i.quantity, 0) })),
    nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
  };
}

export async function getOrder(customerId: string, number: string) {
  const o = await db.order.findFirst({
    where: { number, customerId },
    include: {
      items: { orderBy: { id: "asc" } },
      events: { orderBy: { createdAt: "asc" }, select: { fromStatus: true, toStatus: true, toPaymentStatus: true, createdAt: true } },
      shipments: { orderBy: { createdAt: "asc" }, select: { courier: true, awb: true, trackingUrl: true, status: true, events: { orderBy: { createdAt: "asc" }, select: { status: true, createdAt: true } } } },
      invoice: { select: { number: true, issuedAt: true } },
    },
  });
  if (!o) return null;
  return {
    number: o.number,
    createdAt: o.createdAt,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    isMockPayment: o.paymentMode === "mock",
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    shipping: { name: o.customerName, phone: o.phone, line1: o.addressLine1, line2: o.addressLine2, city: o.city, state: o.state, pincode: o.pincode },
    notes: o.notes,
    items: o.items.map((i) => ({ productName: i.productName, variantLabel: i.variantLabel, sku: i.sku, unitPrice: i.unitPrice, quantity: i.quantity, lineTotal: i.lineTotal })),
    history: o.events.map((e) => ({ from: e.fromStatus, to: e.toStatus, paymentStatus: e.toPaymentStatus, at: e.createdAt })),
    // tracking history without the staff's internal notes
    shipments: o.shipments.map((sh) => ({ courier: sh.courier, awb: sh.awb, trackingUrl: sh.trackingUrl, status: sh.status, events: sh.events.map((e) => ({ status: e.status, at: e.createdAt })) })),
    invoice: o.invoice ? { number: o.invoice.number, issuedAt: o.invoice.issuedAt } : null,
  };
}
