/** M2-T4: Order.paymentMode column, CHECK constraints, legacy rows, createOrder wiring, and mock labels. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { cleanupFixtures, createFixtureOrder, createMockOrderWithAttempt } from "../support/mock-orders";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "request_only");
});
afterAll(async () => {
  await db.order.deleteMany({ where: { OR: [{ number: { startsWith: "VV-MOCK-" } }, { customerName: "SMOKE TEST Mode" }] } });
  await cleanupFixtures();
  await db.$disconnect();
});

describe("database constraints", () => {
  it("allows only consistent mode/method pairs", async () => {
    await expect(createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation" })).resolves.toBeTruthy();
    await expect(createFixtureOrder({ paymentMethod: "razorpay", paymentMode: "razorpay_test" })).resolves.toBeTruthy();
    await expect(createFixtureOrder({ paymentMethod: "razorpay", paymentMode: "razorpay_live" })).resolves.toBeTruthy();
    await expect(createFixtureOrder({ paymentMethod: "razorpay", paymentMode: "mock" })).resolves.toBeTruthy();
    await expect(createFixtureOrder({ paymentMethod: "cod", paymentMode: "mock" })).rejects.toThrow(/Order_paymentMode_method_check/);
    await expect(createFixtureOrder({ paymentMethod: "cod", paymentMode: "razorpay_live" })).rejects.toThrow();
    await expect(createFixtureOrder({ paymentMethod: "razorpay", paymentMode: "request_only" })).rejects.toThrow();
  });

  it("a mock order cannot carry Razorpay identifiers (cannot masquerade as a gateway payment)", async () => {
    await expect(createFixtureOrder({ paymentMode: "mock", razorpayOrderId: "order_real" })).rejects.toThrow(/Order_mock_no_gateway_ids_check/);
    const o = await createFixtureOrder({ paymentMode: "mock" });
    await expect(db.order.update({ where: { id: o.id }, data: { razorpayPaymentId: "pay_real" } })).rejects.toThrow(/Order_mock_no_gateway_ids_check/);
  });

  it("a Payment's provider and mode must agree, and mock payments only carry mock_pay_ ids", async () => {
    const o = await createFixtureOrder();
    const base = { orderId: o.id, amount: 1, currency: "INR" };
    await expect(db.payment.create({ data: { ...base, provider: "mock", mode: "razorpay_live" } })).rejects.toThrow(/Payment_provider_mode_check/);
    await expect(db.payment.create({ data: { ...base, provider: "razorpay", mode: "mock" } })).rejects.toThrow(/Payment_provider_mode_check/);
    await expect(db.payment.create({ data: { ...base, provider: "request_only", mode: "razorpay_test" } })).rejects.toThrow();
    await expect(db.payment.create({ data: { ...base, provider: "mock", mode: "mock", providerPaymentId: "pay_realLooking" } })).rejects.toThrow(/Payment_mock_payment_id_check/);
    await expect(db.payment.create({ data: { ...base, provider: "mock", mode: "mock", providerPaymentId: "mock_pay_ok" } })).resolves.toBeTruthy();
  });

  it("legacy orders (NULL mode) stay readable, unclassified, and are never treated as mock", async () => {
    const legacy = await createFixtureOrder({ paymentMode: null, paymentMethod: "razorpay", razorpayOrderId: "order_legacy", razorpayPaymentId: "pay_legacy", paymentStatus: "paid", status: "paid" });
    const row = await db.order.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(row.paymentMode).toBeNull();
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({ status: "paid", paymentStatus: "paid", paymentMode: null });
    // the admin dashboard's "to action" filter keeps NULL-mode paid orders and drops mock ones
    const mock = await createFixtureOrder({ paymentMode: "mock", status: "paid", paymentStatus: "paid" });
    const where = { id: { in: [legacy.id, mock.id] }, OR: [{ status: "pending_confirmation" as const }, { status: "paid" as const, OR: [{ paymentMode: null }, { paymentMode: { not: "mock" as const } }] }] };
    expect((await db.order.findMany({ where })).map((o) => o.id)).toEqual([legacy.id]);
  });
});

describe("createOrder assigns the mode from server configuration", () => {
  const input = (paymentMethod: "cod" | "razorpay") => ({
    customerName: "SMOKE TEST Mode", email: "smoke.mode@example.com", phone: "9876543210", addressLine1: "1 Test Street", city: "Anantapur",
    state: "Andhra Pradesh" as const, pincode: "515001", paymentMethod, items: [] as { variantId: string; quantity: number }[],
  });
  const withVariant = async (m: "cod" | "razorpay") => {
    const v = await db.variant.findFirstOrThrow({ where: { inStock: true, product: { active: true } } });
    return { ...input(m), items: [{ variantId: v.id, quantity: 1 }] };
  };

  it("COD → request_only, unpaid, pending_confirmation (behaviour unchanged)", async () => {
    const o = await createOrder(await withVariant("cod"));
    expect(o).toMatchObject({ paymentMode: "request_only", paymentStatus: "unpaid", status: "pending_confirmation", paymentMethod: "cod" });
  });
  it("COD under mock mode is still request_only (never mock)", async () => {
    vi.stubEnv("PAYMENT_MODE", "mock");
    expect((await createOrder(await withVariant("cod"))).paymentMode).toBe("request_only");
  });
  it("online order under razorpay_test records razorpay_test; under mock records mock", async () => {
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_abc");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "fake_secret");
    expect((await createOrder(await withVariant("razorpay"))).paymentMode).toBe("razorpay_test");
    vi.stubEnv("PAYMENT_MODE", "mock");
    expect((await createOrder(await withVariant("razorpay"))).paymentMode).toBe("mock");
  });
  it("an online order while online payments are off is refused (no unclassified order is created)", async () => {
    const before = await db.order.count({ where: { customerName: "SMOKE TEST Mode" } });
    await expect(createOrder(await withVariant("razorpay"))).rejects.toThrow("not available");
    expect(await db.order.count({ where: { customerName: "SMOKE TEST Mode" } })).toBe(before);
  });
});

describe("mock identification on the order page", () => {
  const render = async (orderNumber: string, token: string) => {
    const { default: OrderPage } = await import("@/app/order/[number]/page");
    return renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ number: orderNumber }), searchParams: Promise.resolve({ t: token }) }));
  };

  it("shows MOCK — no money moved on a paid mock order and does not claim a real payment", async () => {
    const f = await createMockOrderWithAttempt({ status: "paid", paymentStatus: "paid" });
    const html = await render(f.order.number, f.token);
    expect(html).toContain("MOCK — no money moved");
    expect(html).toContain("Mock payment recorded.");
    expect(html).not.toContain("Payment received");
    expect(html).not.toContain("Razorpay");
  });
  it("does not show the label on request-only or legacy orders", async () => {
    const cod = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "pending_confirmation" });
    expect(await render(cod.number, cod.accessToken)).not.toContain("no money moved");
    const legacy = await createFixtureOrder({ paymentMode: null, razorpayOrderId: "order_old" });
    const html = await render(legacy.number, legacy.accessToken);
    expect(html).not.toContain("no money moved");
    expect(html).toContain("Online (Razorpay)");
  });
});
