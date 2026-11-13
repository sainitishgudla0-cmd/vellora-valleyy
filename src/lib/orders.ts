import "server-only";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { reserveForOrder } from "./inventory/order-stock";
import { enqueueOutbox } from "./notify/outbox";
import { quoteShipping } from "./shipping/rules";
import { supplyTypeFor } from "./tax/calc";
import { snapshotOrderTax } from "./tax/rates";
import { stateCode } from "./tax/states";
import { site } from "@/config/site";
import type { OrderInput } from "./validation";
import { resolveOrderPaymentMode } from "./orders/payment-mode";
import { currentPaymentProvider, safePaymentConfig } from "./payments";
import { mockProviderOrderId } from "./payments/providers/mock";

export class OrderError extends Error {
  /** `fields` lets the checkout form show the problem next to the input (additive: the response keeps `error` and `status`). */
  constructor(message: string, public status = 400, public fields?: Record<string, string>) {
    super(message);
  }
}

function orderNumber() {
  const d = new Date();
  const ymd = `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `VV-${ymd}-${rand}`;
}

/** Order-number collisions are astronomically unlikely (24 random bits per day) but possible: regenerate, at most this many tries. */
export const MAX_ORDER_NUMBER_ATTEMPTS = 3;

/** The idempotency key was already claimed by another request (concurrent or earlier). The caller replays or reports it. */
export class IdempotencyConflictError extends Error {}

export interface IdempotencyClaim {
  keyHash: string;
  requestHash: string;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/** True for a unique-constraint violation on the given column (Postgres reports the column list or the index name). */
function isUniqueViolationOn(e: unknown, column: string) {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.includes(column) : typeof target === "string" && target.includes(column);
}

/**
 * Creates an order using prices from the database (never from the client).
 *
 * Everything happens in ONE transaction (M3, ADR 0011): read variants, check availability, hold stock for tracked
 * variants (a conditional UPDATE per variant, so N parallel orders for the last unit yield exactly one winner),
 * insert the order, its lines and its payment attempt, and claim the idempotency key if one was sent. Any failure
 * rolls all of it back, so a refused order never leaves a hold behind.
 */
export interface WholesaleHooks {
  businessAccountId: string;
  /**
   * Runs inside the order transaction with the loaded variants and merged quantities. Returns the unit price (paise) per
   * variant id, and throws an OrderError for anything the buyer's terms forbid (MOQ, case pack). Retail orders never set this.
   */
  priceLines: (tx: Prisma.TransactionClient, lines: { variant: { id: string; price: number; mrp: number; name: string; label: string }; quantity: number }[]) => Promise<Map<string, number>>;
  /** Delivery fee in paise; defaults to the site fee. */
  deliveryFee?: number;
  /** Runs once totals are known, before anything is written (credit limit). Throw to refuse. */
  beforeCreate?: (tx: Prisma.TransactionClient, totals: { subtotal: number; total: number }) => Promise<void>;
  /** Runs in the same transaction right after the order row exists (e.g. claiming the quote). Throw to roll everything back. */
  afterCreate?: (tx: Prisma.TransactionClient, order: { id: string; number: string; total: number }) => Promise<void>;
}

export interface CreateOrderOptions {
  idempotency?: IdempotencyClaim;
  customerId?: string | null;
  /** Wholesale orders only (M6): negotiated prices, bulk quantities, linked business account. */
  wholesale?: WholesaleHooks;
}

/** Retail lines are capped at 50 units; wholesale buyers order in bulk. */
const RETAIL_LINE_CAP = 50;
const WHOLESALE_LINE_CAP = 100_000;

export async function createOrder(input: OrderInput, opts: CreateOrderOptions = {}) {
  // merge duplicate lines
  const qty = new Map<string, number>();
  const cap = opts.wholesale ? WHOLESALE_LINE_CAP : RETAIL_LINE_CAP;
  for (const i of input.items) qty.set(i.variantId, Math.min(cap, (qty.get(i.variantId) ?? 0) + i.quantity));

  const isOnline = input.paymentMethod === "razorpay";
  // Mode and provider come from trusted server configuration; the request body has no say in either.
  const config = safePaymentConfig();
  const paymentMode = resolveOrderPaymentMode(input.paymentMethod, config);
  if (!paymentMode) throw new OrderError("This payment method is not available.", 400);
  const provider = isOnline ? currentPaymentProvider() : null;
  if (isOnline && (!provider || !provider.online || provider.mode !== paymentMode)) throw new OrderError("This payment method is not available.", 400);

  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction((tx) => insertOrder(tx, input, qty, paymentMode, provider?.id ?? null, opts.idempotency, opts.customerId ?? null, opts.wholesale), { maxWait: 5_000, timeout: 15_000 });
    } catch (e) {
      if (opts.idempotency && isUniqueViolationOn(e, "keyHash")) throw new IdempotencyConflictError();
      if (isUniqueViolationOn(e, "number") && attempt < MAX_ORDER_NUMBER_ATTEMPTS) continue; // fresh number, whole transaction retried
      if (isUniqueViolationOn(e, "number")) throw new OrderError("We could not place your order right now. Please try again.", 503);
      throw e;
    }
  }
}

async function insertOrder(
  tx: Prisma.TransactionClient,
  input: OrderInput,
  qty: Map<string, number>,
  paymentMode: NonNullable<ReturnType<typeof resolveOrderPaymentMode>>,
  providerId: "mock" | "razorpay" | "request_only" | null,
  claim: IdempotencyClaim | undefined,
  customerId: string | null,
  wholesale?: WholesaleHooks,
) {
  if (claim) {
    const now = new Date();
    await tx.idempotencyKey.deleteMany({ where: { keyHash: claim.keyHash, expiresAt: { lt: now } } }); // an expired key may be used again
    await tx.idempotencyKey.create({ data: { keyHash: claim.keyHash, requestHash: claim.requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
  }

  const variants = await tx.variant.findMany({
    where: { id: { in: [...qty.keys()] } },
    include: { product: { select: { name: true, active: true } } },
  });
  if (variants.length !== qty.size) throw new OrderError("Some items in your cart are no longer available. Please review your cart.", 409);
  // Tracked variants are judged by the stock hold below (which names the item and the quantity left); the manual flag only applies to untracked ones.
  const unavailable = variants.filter((v) => !v.product.active || (!v.trackInventory && !v.inStock));
  if (unavailable.length) throw new OrderError(`${unavailable.map((v) => v.product.name).join(", ")} is currently unavailable.`, 409);

  // Retail: the catalogue price. Wholesale: whatever the buyer's terms resolve to (the hook enforces MOQ and case packs).
  const wholesalePrices = wholesale ? await wholesale.priceLines(tx, variants.map((v) => ({ variant: { id: v.id, price: v.price, mrp: v.mrp, name: v.product.name, label: v.label }, quantity: qty.get(v.id)! }))) : null;
  const items = variants.map((v) => {
    const quantity = qty.get(v.id)!;
    const unitPrice = wholesalePrices ? wholesalePrices.get(v.id) : v.price;
    if (unitPrice === undefined || !Number.isInteger(unitPrice) || unitPrice <= 0) throw new OrderError("This item cannot be priced right now.", 409);
    return {
      variantId: v.id,
      productName: v.product.name,
      variantLabel: v.label,
      sku: v.sku,
      unitPrice,
      quantity,
      lineTotal: unitPrice * quantity,
    };
  });
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  // Serviceability applies to every order; the fee comes from the shipping rules unless a quote fixed it (M7-T3).
  const shipping = await quoteShipping(tx, input.pincode, subtotal);
  if (!shipping.serviceable) throw new OrderError("Sorry, we do not deliver to this pincode yet.", 422, { pincode: "We do not deliver to this pincode yet" });
  const deliveryFee = wholesale?.deliveryFee ?? shipping.fee;
  const total = subtotal + deliveryFee;
  if (wholesale?.beforeCreate) await wholesale.beforeCreate(tx, { subtotal, total });

  // GST snapshot (M7-T1): frozen now from the rates in force today; lines without a configured rate stay NULL and are filled at invoice time.
  const sellerCode = stateCode(site.address.state);
  const supply = sellerCode ? supplyTypeFor(sellerCode, stateCode(input.state)) : null;
  const tax = supply ? await snapshotOrderTax(tx, { supply, lines: items.map((i) => ({ hsCode: variants.find((v) => v.id === i.variantId)!.hsCode ?? null, amount: i.lineTotal })), deliveryFee, asOf: new Date() }) : null;
  const itemRows = items.map((i, idx) => {
    const t = tax?.lines[idx];
    return { ...i, hsCode: variants.find((v) => v.id === i.variantId)!.hsCode ?? null, ...(t ? { gstRateBp: t.rateBp, taxableValue: t.taxableValue, cgst: t.cgst, sgst: t.sgst, igst: t.igst } : {}) };
  });
  const delivery = tax && (deliveryFee === 0 ? { rateBp: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 } : tax.delivery);

  const isOnline = input.paymentMethod === "razorpay";
  const number = orderNumber();
  // Every order gets its payment attempt in the same insert (atomic): pay-on-delivery a `request_only`
  // record that stays unpaid; mock an attempt with its deterministic simulated reference; Razorpay a pending
  // attempt whose gateway reference is attached after the (non-transactional) gateway call.
  const attempt = {
    provider: providerId ?? ("request_only" as const),
    mode: paymentMode,
    providerOrderId: providerId === "mock" ? mockProviderOrderId(number) : null,
    amount: total,
    currency: "INR",
    status: "unpaid" as const,
  };
  const order = await tx.order.create({
    data: {
      number,
      accessToken: crypto.randomBytes(18).toString("base64url"),
      status: isOnline ? "awaiting_payment" : "pending_confirmation",
      paymentMethod: input.paymentMethod,
      paymentStatus: "unpaid",
      paymentMode,
      customerId,
      businessAccountId: wholesale?.businessAccountId ?? null,
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 || null,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      notes: input.notes || null,
      subtotal,
      deliveryFee,
      total,
      supplyType: supply,
      ...(delivery ? { deliveryGstRateBp: delivery.rateBp, deliveryTaxable: delivery.taxableValue, deliveryCgst: delivery.cgst, deliverySgst: delivery.sgst, deliveryIgst: delivery.igst } : {}),
      items: { create: itemRows },
      payments: { create: attempt },
    },
    include: { items: true, payments: true },
  });
  if (claim) await tx.idempotencyKey.update({ where: { keyHash: claim.keyHash }, data: { orderId: order.id } });
  await enqueueOutbox(tx, { template: "order_placed", subjectType: "order", subjectId: order.id, dedupeKey: `order-placed:${order.id}` });
  if (wholesale?.afterCreate) await wholesale.afterCreate(tx, { id: order.id, number: order.number, total: order.total });

  // Hold stock for tracked variants. A line that cannot be held aborts (and rolls back) the whole order.
  const tracked = variants.filter((v) => v.trackInventory);
  const short = await reserveForOrder(tx, order.id, tracked.map((v) => ({ variantId: v.id, quantity: qty.get(v.id)! })), { type: "customer" });
  if (short) {
    const v = variants.find((x) => x.id === short.variantId)!;
    const now = await tx.variant.findUnique({ where: { id: v.id }, select: { stockQuantity: true, reserved: true } });
    const left = now ? Math.max(0, now.stockQuantity - now.reserved) : 0;
    const name = `${v.product.name} (${v.label})`;
    throw new OrderError(left > 0 ? `Only ${left} of ${name} left in stock. Please reduce the quantity.` : `${name} is out of stock.`, 409);
  }
  return order;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_confirmation: "Received — awaiting confirmation",
  awaiting_payment: "Awaiting payment",
  confirmed: "Confirmed",
  paid: "Paid — being prepared",
  dispatched: "Dispatched",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
