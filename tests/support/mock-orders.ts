/**
 * Test-only fixtures (never imported by application code, so no public endpoint can create these).
 * They write to the disposable database that the integration global-setup has already proven safe.
 */
import type { OrderStatus, PaymentMethod, PaymentMode, PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { createMockProvider, mockProof } from "@/lib/payments/providers/mock";
import { recordPaymentAttempt } from "@/lib/payments/records";

export const FIXTURE_PREFIX = "VV-MOCK-";
let seq = 0;

export async function createFixtureOrder(over: { status?: OrderStatus; paymentMethod?: PaymentMethod; paymentStatus?: PaymentStatus; paymentMode?: PaymentMode | null; total?: number; razorpayOrderId?: string; razorpayPaymentId?: string } = {}) {
  const number = `${FIXTURE_PREFIX}${Date.now()}-${seq++}`;
  const total = over.total ?? 105000;
  const order = await db.order.create({
    data: {
      number, accessToken: `tok-${number}`,
      status: over.status ?? "awaiting_payment",
      paymentMethod: over.paymentMethod ?? "razorpay",
      paymentStatus: over.paymentStatus ?? "unpaid",
      paymentMode: over.paymentMode === undefined ? "mock" : over.paymentMode,
      razorpayOrderId: over.razorpayOrderId, razorpayPaymentId: over.razorpayPaymentId,
      customerName: "SMOKE TEST Mock", email: "smoke.mock@example.com", phone: "9876543210", addressLine1: "1 Test Street",
      city: "Anantapur", state: "Andhra Pradesh", pincode: "515001", subtotal: total - 5000, deliveryFee: 5000, total,
    },
  });
  return order;
}

/** A mock order plus its pending mock payment attempt, as the T5 checkout will create them. */
export async function createMockOrderWithAttempt(over: Parameters<typeof createFixtureOrder>[0] & { attemptAmount?: number } = {}) {
  const order = await createFixtureOrder(over);
  const provider = createMockProvider({ mode: "mock", appEnv: "test" });
  const created = (await provider.createPayment({ orderNumber: order.number, amountPaise: order.total, currency: "INR" }))!;
  const attempt = await recordPaymentAttempt(provider, order.id, { ...created, amountPaise: over.attemptAmount ?? created.amountPaise });
  const proof = mockProof(created.providerOrderId);
  return { order, attempt, token: order.accessToken, providerOrderId: created.providerOrderId, proof };
}

export const confirmBody = (f: { order: { number: string }; token: string; providerOrderId: string; proof: { providerPaymentId: string; signature: string } }) => ({
  orderNumber: f.order.number, token: f.token, providerOrderId: f.providerOrderId, providerPaymentId: f.proof.providerPaymentId, signature: f.proof.signature,
});

export async function cleanupFixtures() {
  await db.order.deleteMany({ where: { number: { startsWith: FIXTURE_PREFIX } } }); // cascades to Payment and OrderEvent
}
