import "server-only";
import crypto from "node:crypto";
import { Prisma, type BusinessAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { createOrder, OrderError } from "@/lib/orders";
import type { OrderInput } from "@/lib/validation";
import { site } from "@/config/site";
import { creditCheck, loadQuantityTerms } from "./pricing";
import { transitionQuote } from "./quote-machine";
import { NO_RESTRICTION, quantityProblem } from "./rules";

/**
 * Quotes (M6-T4, ADR 0014): a buyer asks for prices on a basket, staff price it, the buyer accepts within its validity and
 * an order is created at exactly the quoted prices. Accepting is one transaction: the order (with its stock holds and
 * credit check) and the quote's move to `accepted` commit together or not at all.
 */
export const DEFAULT_VALID_DAYS = 7;
export const MAX_VALID_DAYS = 30;
export const MAX_QUOTE_LINES = 60;
const MAX_QUOTE_QTY = 100_000;

export type QuoteErrorCode = "not_found" | "actor_not_allowed" | "invalid_transition" | "stale_state" | "quote_expired" | "validation" | "account_not_approved" | "items_mismatch" | "total_mismatch";
export type QuoteResult<T = object> = ({ ok: true } & T) | { ok: false; code: QuoteErrorCode; message: string; fields?: Record<string, string> };
const fail = (code: QuoteErrorCode, message: string, fields?: Record<string, string>): { ok: false; code: QuoteErrorCode; message: string; fields?: Record<string, string> } => ({ ok: false, code, message, fields });

class QuoteAbort extends Error {
  constructor(public code: QuoteErrorCode, message: string) {
    super(message);
  }
}

function quoteNumber() {
  const d = new Date();
  const ymd = `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `QT-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

const itemSelect = { variantId: true, productName: true, variantLabel: true, sku: true, quantity: true, unitPrice: true, lineTotal: true } as const;

/** Buyer-facing quote. Prices appear only once staff have quoted. */
export function buyerView(q: Prisma.QuoteGetPayload<{ include: { items: true; order: { select: { number: true } } } }>) {
  const priced = q.status === "quoted" || q.status === "accepted" || q.status === "expired" || q.status === "declined" || q.status === "cancelled";
  return {
    number: q.number,
    status: q.status,
    requestNote: q.requestNote,
    buyerNote: q.buyerNote,
    createdAt: q.createdAt,
    quotedAt: q.quotedAt,
    validUntil: q.validUntil,
    orderNumber: q.order?.number ?? null,
    items: q.items.map((i) => ({ variantId: i.variantId, productName: i.productName, variantLabel: i.variantLabel, sku: i.sku, quantity: i.quantity, ...(priced && q.quotedAt ? { unitPrice: i.unitPrice, lineTotal: i.lineTotal } : {}) })),
    ...(priced && q.quotedAt ? { subtotal: q.subtotal, deliveryFee: q.deliveryFee, total: q.total } : {}),
  };
}
const buyerInclude = { items: { orderBy: { id: "asc" as const } }, order: { select: { number: true } } };

export async function requestQuote(account: BusinessAccount, input: { items: { variantId: string; quantity: number }[]; note?: string | null }): Promise<QuoteResult<{ quote: ReturnType<typeof buyerView> }>> {
  if (account.status !== "approved") return fail("account_not_approved", "Your business account is not approved");
  const merged = new Map<string, number>();
  for (const i of input.items) merged.set(i.variantId, (merged.get(i.variantId) ?? 0) + i.quantity);
  if (merged.size === 0 || merged.size > MAX_QUOTE_LINES) return fail("validation", `A quote needs 1 to ${MAX_QUOTE_LINES} different items`);
  const variants = await db.variant.findMany({ where: { id: { in: [...merged.keys()] }, product: { active: true } }, include: { product: { select: { name: true } } } });
  if (variants.length !== merged.size) return fail("validation", "Some items are no longer available", { items: "Some items are no longer available" });
  const terms = await loadQuantityTerms(db, [...merged.keys()]);
  const problems: Record<string, string> = {};
  for (const v of variants) {
    const qty = merged.get(v.id)!;
    const p = qty > MAX_QUOTE_QTY ? `Quantity is too large` : quantityProblem(terms.get(v.id) ?? NO_RESTRICTION, qty);
    if (p) problems[v.id] = `${v.product.name} (${v.label}): ${p}`;
  }
  if (Object.keys(problems).length) return fail("validation", Object.values(problems)[0], problems);

  for (let attempt = 1; ; attempt++) {
    try {
      const q = await db.quote.create({
        data: {
          number: quoteNumber(),
          businessAccountId: account.id,
          requestNote: input.note?.trim() || null,
          items: { create: variants.map((v) => ({ variantId: v.id, productName: v.product.name, variantLabel: v.label, sku: v.sku, quantity: merged.get(v.id)! })) },
        },
        include: buyerInclude,
      });
      return { ok: true, quote: buyerView(q) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && attempt < 3) continue; // number collision: fresh number
      throw e;
    }
  }
}

export async function listBuyerQuotes(accountId: string) {
  const rows = await db.quote.findMany({ where: { businessAccountId: accountId }, orderBy: { createdAt: "desc" }, take: 100, include: buyerInclude });
  return rows.map(buyerView);
}

/** Another account's quote number is indistinguishable from an unknown one. */
export async function getBuyerQuote(accountId: string, number: string) {
  const q = await db.quote.findFirst({ where: { number, businessAccountId: accountId }, include: buyerInclude });
  return q ? buyerView(q) : null;
}

export interface QuotePricing {
  items: { variantId: string; unitPrice: number }[];
  /** paise; defaults to the site delivery fee */
  deliveryFee?: number;
  validDays?: number;
  buyerNote?: string | null;
}

/** Staff price (or re-price) a quote. Every requested line must be priced, within 1 paise and the variant's MRP. */
export async function priceQuote(quoteId: string, pricing: QuotePricing, adminId: string, now = new Date()): Promise<QuoteResult<{ quote: { number: string; status: string; total: number; validUntil: Date } }>> {
  const validDays = pricing.validDays ?? DEFAULT_VALID_DAYS;
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) return fail("validation", `Validity must be 1 to ${MAX_VALID_DAYS} days`, { validDays: "Invalid validity" });
  const deliveryFee = pricing.deliveryFee ?? site.delivery.fee;
  return db.$transaction(async (tx) => {
    const q = await tx.quote.findUnique({ where: { id: quoteId }, include: { items: true, businessAccount: { select: { status: true } } } });
    if (!q) return fail("not_found", "Quote not found");
    if (q.businessAccount.status !== "approved") return fail("account_not_approved", "The business account is not approved");
    const price = new Map(pricing.items.map((i) => [i.variantId, i.unitPrice]));
    if (price.size !== pricing.items.length || price.size !== q.items.length || q.items.some((i) => !price.has(i.variantId))) return fail("items_mismatch", "Price every requested item exactly once", { items: "Price every requested item exactly once" });
    const variants = await tx.variant.findMany({ where: { id: { in: q.items.map((i) => i.variantId) } }, select: { id: true, mrp: true } });
    const mrp = new Map(variants.map((v) => [v.id, v.mrp]));
    for (const i of q.items) {
      const p = price.get(i.variantId)!;
      if (!Number.isInteger(p) || p <= 0 || p > (mrp.get(i.variantId) ?? 0)) return fail("validation", `${i.productName} (${i.variantLabel}): the price must be above zero and not above the MRP`, { [i.variantId]: "Invalid price" });
    }
    let subtotal = 0;
    for (const i of q.items) {
      const unitPrice = price.get(i.variantId)!;
      const lineTotal = unitPrice * i.quantity;
      subtotal += lineTotal;
      await tx.quoteItem.update({ where: { quoteId_variantId: { quoteId, variantId: i.variantId } }, data: { unitPrice, lineTotal } });
    }
    const validUntil = new Date(now.getTime() + validDays * 86_400_000);
    const total = subtotal + deliveryFee;
    const t = await transitionQuote(tx, { quoteId, from: q.status, to: "quoted", actor: { type: "admin", id: adminId }, data: { subtotal, deliveryFee, total, validUntil, quotedAt: now, buyerNote: pricing.buyerNote?.trim() || null } });
    if (!t.ok) throw new QuoteAbort(t.code === "invalid_transition" ? "invalid_transition" : "stale_state", t.message); // rolls back the item prices too
    return { ok: true as const, quote: { number: q.number, status: "quoted", total, validUntil } };
  }).catch((e) => {
    if (e instanceof QuoteAbort) return fail(e.code, e.message);
    throw e;
  });
}

/** Staff reject or cancel; the buyer declines or cancels. One entry point so the rules live in the state machine. */
export async function moveQuote(quoteId: string, to: "rejected" | "cancelled" | "declined", actor: { type: "admin" | "customer"; id: string }, scope?: { accountId: string }): Promise<QuoteResult> {
  return db.$transaction(async (tx) => {
    const q = await tx.quote.findFirst({ where: { id: quoteId, ...(scope ? { businessAccountId: scope.accountId } : {}) }, select: { status: true } });
    if (!q) return fail("not_found", "Quote not found");
    const t = await transitionQuote(tx, { quoteId, from: q.status, to, actor, data: { decidedAt: new Date() } });
    return t.ok ? { ok: true as const } : fail(t.code, t.message);
  });
}

/** Marks quotes past their validity as expired (called by the scheduled job; accepting also checks the clock itself). */
export async function expireQuotes(now = new Date(), limit = 200): Promise<number> {
  const due = await db.quote.findMany({ where: { status: "quoted", validUntil: { lt: now } }, select: { id: true }, take: limit });
  let n = 0;
  for (const { id } of due) {
    const done = await db.$transaction((tx) => transitionQuote(tx, { quoteId: id, from: "quoted", to: "expired", actor: { type: "system", id: "expiry" }, data: { decidedAt: now } }));
    if (done.ok) n++;
  }
  return n;
}

/** Buyer accepts: creates the order at the quoted prices and moves the quote to `accepted`, atomically. */
export async function acceptQuote(
  account: BusinessAccount,
  customerId: string,
  number: string,
  shipping: Omit<OrderInput, "items" | "paymentMethod">,
  now = new Date(),
): Promise<QuoteResult<{ order: { number: string; token: string; total: number } }>> {
  if (account.status !== "approved") return fail("account_not_approved", "Your business account is not approved");
  const quote = await db.quote.findFirst({ where: { number, businessAccountId: account.id }, include: { items: true } });
  if (!quote) return fail("not_found", "Quote not found");
  if (quote.status !== "quoted") return fail("invalid_transition", `This quote is ${quote.status} and cannot be accepted`);
  if (!quote.validUntil || quote.validUntil <= now || quote.total === null || quote.deliveryFee === null) {
    await db.$transaction((tx) => transitionQuote(tx, { quoteId: quote.id, from: "quoted", to: "expired", actor: { type: "system", id: "accept-check" }, data: { decidedAt: now } }));
    return fail("quote_expired", "This quote has expired. Please request a new one.");
  }
  const prices = new Map(quote.items.map((i) => [i.variantId, i.unitPrice]));
  if ([...prices.values()].some((p) => p === null)) return fail("stale_state", "This quote is not fully priced");
  const input: OrderInput = { ...shipping, paymentMethod: "cod", items: quote.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) };
  try {
    const order = await createOrder(input, {
      customerId,
      wholesale: {
        businessAccountId: account.id,
        deliveryFee: quote.deliveryFee,
        priceLines: async (_tx, lines) => {
          if (lines.length !== prices.size || lines.some((l) => !prices.has(l.variant.id))) throw new QuoteAbort("items_mismatch", "The quoted items are no longer available as quoted");
          return new Map(lines.map((l) => [l.variant.id, prices.get(l.variant.id)!]));
        },
        beforeCreate: creditCheck(account),
        afterCreate: async (tx, o) => {
          const fresh = await tx.quote.findUnique({ where: { id: quote.id }, select: { validUntil: true, total: true } });
          if (!fresh?.validUntil || fresh.validUntil <= new Date()) throw new QuoteAbort("quote_expired", "This quote has expired. Please request a new one.");
          if (fresh.total !== o.total) throw new QuoteAbort("total_mismatch", "The order total does not match the quote"); // never silently charge a different amount
          const t = await transitionQuote(tx, { quoteId: quote.id, from: "quoted", to: "accepted", actor: { type: "customer", id: customerId }, data: { decidedAt: new Date(), orderId: o.id } });
          if (!t.ok) throw new QuoteAbort("stale_state", "The quote changed while you were accepting it");
        },
      },
    });
    return { ok: true, order: { number: order.number, token: order.accessToken, total: order.total } };
  } catch (e) {
    if (e instanceof QuoteAbort) return fail(e.code, e.message);
    throw e; // OrderError (stock, credit limit, ...) is handled by the route like any order
  }
}

export { OrderError };
