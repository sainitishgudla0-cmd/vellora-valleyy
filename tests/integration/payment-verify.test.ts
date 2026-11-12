/**
 * Payment verification against a real Postgres (conditional updates, concurrency).
 * Requires a migrated disposable database: see `npm run verify:full` / docs/TESTING.md.
 */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { POST } from "@/app/api/payments/razorpay/verify/route";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => true) }));

const SECRET = "integration_secret";
const sign = (o: string, p: string) => crypto.createHmac("sha256", SECRET).update(`${o}|${p}`).digest("hex");
const PREFIX = "VV-ITEST-";
let seq = 0;

async function makeOrder(over: Partial<{ status: OrderStatus; paymentStatus: PaymentStatus; razorpayPaymentId: string }> = {}) {
  const n = `${PREFIX}${Date.now()}-${seq++}`;
  return db.order.create({
    data: {
      number: n,
      accessToken: `tok-${n}`,
      status: "awaiting_payment",
      paymentMethod: "razorpay",
      paymentStatus: "unpaid",
      customerName: "SMOKE TEST Integration",
      email: "smoke.integration@example.com",
      phone: "9876543210",
      addressLine1: "1 Test Street",
      city: "Anantapur",
      state: "Andhra Pradesh",
      pincode: "515002",
      subtotal: 10000,
      deliveryFee: 0,
      total: 10000,
      razorpayOrderId: `order_${n}`,
      ...over,
    },
  });
}

const verify = async (o: { number: string; accessToken: string; razorpayOrderId: string | null }, paymentId: string, signature?: string) => {
  const body = {
    orderNumber: o.number,
    token: o.accessToken,
    razorpay_order_id: o.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature ?? sign(o.razorpayOrderId!, paymentId),
  };
  const res = await POST(new Request("http://localhost/api/payments/razorpay/verify", { method: "POST", body: JSON.stringify(body) }));
  return res.status;
};

const reload = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

describe("payment verification (Postgres)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_integration");
    vi.stubEnv("RAZORPAY_KEY_SECRET", SECRET);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await db.order.deleteMany({ where: { number: { startsWith: PREFIX } } });
    await db.$disconnect();
  });

  it("marks an awaiting order paid", async () => {
    const o = await makeOrder();
    expect(await verify(o, "pay_A")).toBe(200);
    expect(await reload(o.id)).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_A" });
  });

  it("an invalid signature leaves a paid order untouched", async () => {
    const o = await makeOrder({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_A" });
    expect(await verify(o, "pay_A", "f".repeat(64))).toBe(400);
    const after = await reload(o.id);
    expect(after).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_A" });
    expect(after.updatedAt.getTime()).toBe(o.updatedAt.getTime());
  });

  it("a cancelled order is never marked paid", async () => {
    const o = await makeOrder({ status: "cancelled" });
    expect(await verify(o, "pay_C")).toBe(409);
    expect(await reload(o.id)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid", razorpayPaymentId: null });
  });

  it("repeat verification is idempotent and does not write", async () => {
    const o = await makeOrder();
    expect(await verify(o, "pay_R")).toBe(200);
    const first = await reload(o.id);
    expect(await verify(o, "pay_R")).toBe(200);
    expect((await reload(o.id)).updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("concurrent identical verifications all succeed and write exactly once", async () => {
    const o = await makeOrder();
    const statuses = await Promise.all(Array.from({ length: 6 }, () => verify(o, "pay_P")));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(await reload(o.id)).toMatchObject({ status: "paid", razorpayPaymentId: "pay_P" });
  });

  it("concurrent verifications of two different payments: one wins, the other is a conflict", async () => {
    const o = await makeOrder();
    const statuses = (await Promise.all([verify(o, "pay_X"), verify(o, "pay_Y")])).sort();
    expect(statuses).toEqual([200, 409]);
    const after = await reload(o.id);
    expect(after.paymentStatus).toBe("paid");
    expect(["pay_X", "pay_Y"]).toContain(after.razorpayPaymentId);
  });
});
