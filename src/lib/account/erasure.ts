import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { keyedHash } from "@/lib/auth/customer";

/**
 * Data export and erasure for a customer (M5-T6, DPDP Act 2023, ADR 0013).
 *
 * EXPORT returns everything held about the person as JSON: profile, addresses, consent history, orders (placed while
 * signed in AND guest orders under the same email), enquiries and newsletter status. No tokens, gateway ids, hashes or
 * staff-written reasons.
 *
 * ERASURE removes the account and what hangs off it (sessions, addresses, consent records, sign-in challenges,
 * newsletter row) and ANONYMISES, rather than deletes, the orders and enquiries: order rows carry amounts, items and
 * payment records that bookkeeping and tax need. The direct identifiers on them (name, email, phone, street address, city,
 * pincode, notes) are replaced; the state is kept for place-of-supply. How long order records must be kept is for the
 * business and its advisers to confirm; this keeps only what a ledger needs. Erasure is refused while any of the person's
 * orders is still open (pending, awaiting payment, confirmed, paid, dispatched) because fulfilment needs the address.
 */
export const OPEN_ORDER_STATUSES = ["pending_confirmation", "awaiting_payment", "confirmed", "paid", "dispatched"] as const;
export const ERASED_EMAIL = "erased@erased.invalid";

const orderWhere = (customerId: string, email: string) => ({ OR: [{ customerId }, { email: { equals: email, mode: "insensitive" as const } }] });

export async function exportCustomerData(customerId: string) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return null;
  const [addresses, consents, orders, enquiries, subscriber, business] = await Promise.all([
    db.address.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } }),
    db.consentRecord.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } }),
    db.order.findMany({ where: orderWhere(customerId, customer.email), orderBy: { createdAt: "asc" }, include: { items: true } }),
    db.enquiry.findMany({ where: { email: { equals: customer.email, mode: "insensitive" } }, orderBy: { createdAt: "asc" } }),
    db.subscriber.findFirst({ where: { email: { equals: customer.email, mode: "insensitive" } } }),
    db.businessAccount.findFirst({ where: { OR: [{ customerId }, { customerId: null, contactEmail: customer.email }] }, include: { quotes: { include: { items: true }, orderBy: { createdAt: "asc" } } } }),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    customer: { email: customer.email, name: customer.name, phone: customer.phone, marketingConsent: customer.marketingConsent, createdAt: customer.createdAt, lastLoginAt: customer.lastLoginAt },
    addresses: addresses.map(({ customerId: _c, ...a }) => a),
    consents: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, version: c.version, at: c.createdAt })),
    orders: orders.map((o) => ({
      number: o.number,
      placedAt: o.createdAt,
      linkedToAccount: o.customerId === customerId,
      status: o.status,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      customerName: o.customerName,
      email: o.email,
      phone: o.phone,
      address: { line1: o.addressLine1, line2: o.addressLine2, city: o.city, state: o.state, pincode: o.pincode },
      notes: o.notes,
      items: o.items.map((i) => ({ productName: i.productName, variantLabel: i.variantLabel, sku: i.sku, unitPrice: i.unitPrice, quantity: i.quantity, lineTotal: i.lineTotal })),
    })),
    enquiries: enquiries.map((e) => ({ type: e.type, name: e.name, email: e.email, phone: e.phone, company: e.company, city: e.city, interest: e.interest, message: e.message, at: e.createdAt })),
    businessAccount: business ? { status: business.status, companyName: business.companyName, gstin: business.gstin, contactName: business.contactName, phone: business.phone, paymentTerms: business.paymentTerms, createdAt: business.createdAt, quotes: business.quotes.map((q) => ({ number: q.number, status: q.status, total: q.total, requestedAt: q.createdAt, items: q.items.map((i) => ({ productName: i.productName, variantLabel: i.variantLabel, quantity: i.quantity, unitPrice: i.unitPrice })) })) } : null,
    newsletter: subscriber ? { subscribed: true, since: subscriber.createdAt } : { subscribed: false },
  };
}

export type EraseResult = { ok: true; ordersAnonymised: number } | { ok: false; code: "open_orders" | "not_found" | "business_account"; message: string; openOrders?: number };

export async function eraseCustomer(customerId: string): Promise<EraseResult> {
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { email: true } });
    if (!customer) return { ok: false as const, code: "not_found" as const, message: "Account not found" };
    // A live business account (pending, approved or suspended) must be closed by staff first: it has quotes, terms and credit attached.
    const biz = await tx.businessAccount.findFirst({ where: { OR: [{ customerId }, { customerId: null, contactEmail: customer.email }] }, select: { id: true, status: true } });
    if (biz && (biz.status === "pending" || biz.status === "approved" || biz.status === "suspended")) return { ok: false as const, code: "business_account" as const, message: "Your business account must be closed before your account can be deleted. Please contact us." };
    const where = orderWhere(customerId, customer.email);
    const open = await tx.order.count({ where: { ...where, status: { in: [...OPEN_ORDER_STATUSES] } } });
    if (open > 0) return { ok: false as const, code: "open_orders" as const, message: "You still have orders in progress. Your account can be deleted once they are delivered or cancelled.", openOrders: open };

    const orders = await tx.order.findMany({ where, select: { id: true } });
    const ids = orders.map((o) => o.id);
    for (const id of ids) {
      // a fresh unguessable token per order, so any old guest link stops working
      await tx.order.update({
        where: { id },
        data: { customerId: null, customerName: "Erased customer", email: ERASED_EMAIL, phone: "0000000000", addressLine1: "Erased", addressLine2: null, city: "Erased", pincode: "000000", notes: null, accessToken: crypto.randomBytes(18).toString("base64url") },
      });
    }
    // A closed or rejected business account keeps its company identity (name, GSTIN) but loses the person
    if (biz) await tx.businessAccount.update({ where: { id: biz.id }, data: { customerId: null, contactName: "Erased", contactEmail: ERASED_EMAIL, phone: "0000000000", message: null, adminNote: null } });
    await tx.idempotencyKey.deleteMany({ where: { orderId: { in: ids } } }); // stored replay bodies contain order tokens
    await tx.enquiry.updateMany({ where: { email: { equals: customer.email, mode: "insensitive" } }, data: { name: "Erased", email: ERASED_EMAIL, phone: null, company: null, city: null, message: "[removed at the customer's request]" } });
    await tx.subscriber.deleteMany({ where: { email: { equals: customer.email, mode: "insensitive" } } });
    await tx.otpChallenge.deleteMany({ where: { emailHash: keyedHash("customer-email", customer.email) } });
    await tx.customer.delete({ where: { id: customerId } }); // sessions, addresses, consent records cascade
    return { ok: true as const, ordersAnonymised: ids.length };
  });
}
