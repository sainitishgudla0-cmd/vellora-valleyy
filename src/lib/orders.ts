import "server-only";
import crypto from "node:crypto";
import { db } from "./db";
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

/**
 * Creates an order using prices from the database (never from the client).
 */
export async function createOrder(input: OrderInput) {
  // merge duplicate lines
  const qty = new Map<string, number>();
  for (const i of input.items) qty.set(i.variantId, Math.min(50, (qty.get(i.variantId) ?? 0) + i.quantity));

  const variants = await db.variant.findMany({
    where: { id: { in: [...qty.keys()] } },
    include: { product: { select: { name: true, active: true } } },
  });
  if (variants.length !== qty.size) throw new OrderError("Some items in your cart are no longer available. Please review your cart.", 409);
  const unavailable = variants.filter((v) => !v.inStock || !v.product.active);
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
  // Mode and provider come from trusted server configuration; the request body has no say in either.
  const config = safePaymentConfig();
  const paymentMode = resolveOrderPaymentMode(input.paymentMethod, config);
  if (!paymentMode) throw new OrderError("This payment method is not available.", 400);
  const provider = isOnline ? currentPaymentProvider() : null;
  if (isOnline && (!provider || !provider.online || provider.mode !== paymentMode)) throw new OrderError("This payment method is not available.", 400);

  const number = orderNumber();
  // Every order gets its payment attempt in the same insert (atomic): pay-on-delivery a `request_only`
  // record that stays unpaid; mock an attempt with its deterministic simulated reference; Razorpay a pending
  // attempt whose gateway reference is attached after the (non-transactional) gateway call.
  const attempt = {
    provider: provider ? provider.id : ("request_only" as const),
    mode: paymentMode,
    providerOrderId: provider?.id === "mock" ? mockProviderOrderId(number) : null,
    amount: total,
    currency: "INR",
    status: "unpaid" as const,
  };
  return db.order.create({
    data: {
      number,
      accessToken: crypto.randomBytes(18).toString("base64url"),
      status: isOnline ? "awaiting_payment" : "pending_confirmation",
      paymentMethod: input.paymentMethod,
      paymentStatus: "unpaid",
      paymentMode,
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
