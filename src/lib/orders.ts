import "server-only";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { reserveForOrder } from "./inventory/order-stock";
import { site } from "@/config/site";
import type { OrderInput } from "./validation";
import { resolveOrderPaymentMode } from "./orders/payment-mode";
import { currentPaymentProvider, safePaymentConfig } from "./payments";
import { mockProviderOrderId } from "./payments/providers/mock";

export class OrderError extends Error {
  constructor(message: string, public status = 400) {
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
export async function createOrder(input: OrderInput, opts: { idempotency?: IdempotencyClaim; customerId?: string | null } = {}) {
  // merge duplicate lines
  const qty = new Map<string, number>();
  for (const i of input.items) qty.set(i.variantId, Math.min(50, (qty.get(i.variantId) ?? 0) + i.quantity));

  const isOnline = input.paymentMethod === "razorpay";
  // Mode and provider come from trusted server configuration; the request body has no say in either.
  const config = safePaymentConfig();
  const paymentMode = resolveOrderPaymentMode(input.paymentMethod, config);
  if (!paymentMode) throw new OrderError("This payment method is not available.", 400);
  const provider = isOnline ? currentPaymentProvider() : null;
  if (isOnline && (!provider || !provider.online || provider.mode !== paymentMode)) throw new OrderError("This payment method is not available.", 400);

  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction((tx) => insertOrder(tx, input, qty, paymentMode, provider?.id ?? null, opts.idempotency, opts.customerId ?? null), { maxWait: 5_000, timeout: 15_000 });
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

  const items = variants.map((v) => {
    const quantity = qty.get(v.id)!;
    return {
      variantId: v.id,
      productName: v.product.name,
      variantLabel: v.label,
      sku: v.sku,
      unitPrice: v.price,
      quantity,
      lineTotal: v.price * quantity,
    };
  });
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const deliveryFee = site.delivery.fee;
  const total = subtotal + deliveryFee;

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
      items: { create: items },
      payments: { create: attempt },
    },
    include: { items: true, payments: true },
  });
  if (claim) await tx.idempotencyKey.update({ where: { keyHash: claim.keyHash }, data: { orderId: order.id } });

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
