import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordPaymentAttempt } from "@/lib/payments/records";

const PREFIX = "VV-PAY-";
let seq = 0;
const makeOrder = () => {
  const n = `${PREFIX}${Date.now()}-${seq++}`;
  return db.order.create({
    data: {
      number: n, accessToken: `tok-${n}`, status: "awaiting_payment", paymentMethod: "razorpay",
      customerName: "SMOKE TEST Pay", email: "smoke.pay@example.com", phone: "9876543210", addressLine1: "1 Test Street",
      city: "Anantapur", state: "Andhra Pradesh", pincode: "515001", subtotal: 1000, deliveryFee: 50, total: 1050,
    },
  });
};
afterAll(async () => {
  await db.order.deleteMany({ where: { number: { startsWith: PREFIX } } });
  await db.$disconnect();
});

describe("Payment records (real database)", () => {
  it("stores an unpaid attempt carrying provider and mode, leaving the order untouched", async () => {
    const o = await makeOrder();
    const p = await recordPaymentAttempt({ id: "mock", mode: "mock" }, o.id, { providerOrderId: `mock_order_${o.number}`, amountPaise: 1050, currency: "INR" });
    expect(p).toMatchObject({ orderId: o.id, provider: "mock", mode: "mock", amount: 1050, currency: "INR", status: "unpaid", providerPaymentId: null });
    expect(await db.order.findUniqueOrThrow({ where: { id: o.id }, select: { status: true, paymentStatus: true } })).toEqual({ status: "awaiting_payment", paymentStatus: "unpaid" });
  });

  it("a request-only attempt needs no provider order id", async () => {
    const o = await makeOrder();
    const p = await recordPaymentAttempt({ id: "request_only", mode: "request_only" }, o.id, { amountPaise: 1050, currency: "INR" });
    expect(p).toMatchObject({ provider: "request_only", mode: "request_only", providerOrderId: null });
  });

  it("a gateway payment id can belong to only one attempt", async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    const pa = await recordPaymentAttempt({ id: "razorpay", mode: "razorpay_test" }, a.id, { providerOrderId: "order_X", amountPaise: 1050, currency: "INR" });
    const pb = await recordPaymentAttempt({ id: "razorpay", mode: "razorpay_test" }, b.id, { providerOrderId: "order_Y", amountPaise: 1050, currency: "INR" });
    await db.payment.update({ where: { id: pa.id }, data: { providerPaymentId: "pay_DUP" } });
    await expect(db.payment.update({ where: { id: pb.id }, data: { providerPaymentId: "pay_DUP" } })).rejects.toThrow();
  });

  it("rejects unknown provider/mode values and cascades on order delete", async () => {
    const o = await makeOrder();
    await expect(db.payment.create({ data: { orderId: o.id, provider: "paypal" as never, mode: "mock", amount: 1, currency: "INR" } })).rejects.toThrow();
    await expect(db.payment.create({ data: { orderId: o.id, provider: "mock", mode: "live" as never, amount: 1, currency: "INR" } })).rejects.toThrow();
    await recordPaymentAttempt({ id: "mock", mode: "mock" }, o.id, { providerOrderId: "m", amountPaise: 1, currency: "INR" });
    await db.order.delete({ where: { id: o.id } });
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
  });
});
