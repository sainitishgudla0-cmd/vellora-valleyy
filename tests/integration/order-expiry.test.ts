/** M3-T3: expiry of unpaid online orders releases their stock; the cron route is guarded. Gateway is a deterministic fake. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { expireUnpaidOrders, MIN_PAYMENT_WINDOW_MINUTES } from "@/lib/orders/expire";
import { startOnlinePayment } from "@/lib/payments/checkout";
import { currentPaymentProvider, safePaymentConfig } from "@/lib/payments";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures } from "../support/mock-orders";
import { cleanupInventoryFixtures, createInventoryVariant, customer, movements, variantState } from "../support/inventory";
import { GET as expireRoute } from "@/app/api/internal/orders/expire/route";

const CRON = "test-only-cron-secret-0123456789abcdef";
let fake: FakeRazorpay;
const config = () => safePaymentConfig()!;
const old = (minutes = 120) => new Date(Date.now() - minutes * 60_000);

function setMode(mode: "mock" | "razorpay_test" | "request_only") {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", mode);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  if (mode === "razorpay_test") {
    vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
    vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  }
}

/** A real online order placed through createOrder (+ the gateway call for razorpay), aged by `ageMinutes`. */
async function placeOnline(stock: number, qty: number, ageMinutes = 120) {
  const t = await createInventoryVariant({ stock });
  const order = await createOrder({ ...customer, paymentMethod: "razorpay", items: [{ variantId: t.variantId, quantity: qty }] });
  const started = await startOnlinePayment(order, order.payments[0].id, currentPaymentProvider()!);
  expect(started.kind).toBe("ready");
  await db.order.update({ where: { id: order.id }, data: { createdAt: old(ageMinutes) } }); // non-status write: test setup only
  return { t, order };
}
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: true, events: true } });

beforeEach(() => {
  setMode("razorpay_test");
  fake = new FakeRazorpay().install();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupInventoryFixtures();
  await cleanupFixtures();
  await db.$disconnect();
});

describe("expireUnpaidOrders", () => {
  it("cancels an abandoned order past the window, fails its attempt and releases the stock", async () => {
    const { t, order } = await placeOnline(5, 3);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 3 });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.expired).toBeGreaterThanOrEqual(1);
    const o = await load(order.id);
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "failed" });
    expect(o.payments[0]).toMatchObject({ status: "failed", reconcileReason: "payment_window_expired" });
    expect(o.events).toHaveLength(1);
    expect(o.events[0]).toMatchObject({ actorType: "system", actorId: "expiry", fromStatus: "awaiting_payment", toStatus: "cancelled" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0, stockQuantity: 5 });
    expect((await movements(t.variantId)).at(-1)).toMatchObject({ reason: "release", actorType: "system" });
  });

  it("leaves orders inside the window alone, and never goes below the 15 minute floor", async () => {
    const recent = await placeOnline(5, 1, 5);
    await expireUnpaidOrders(config(), { windowMinutes: 1 }); // asks for 1 minute, floor is 15
    expect((await load(recent.order.id)).status).toBe("awaiting_payment");
    expect(MIN_PAYMENT_WINDOW_MINUTES).toBe(15);
    const aged = await placeOnline(5, 1, 20);
    await expireUnpaidOrders(config(), { windowMinutes: 15 });
    expect((await load(aged.order.id)).status).toBe("cancelled");
  });

  it("marks an order paid (and keeps the stock) when the gateway says the money was captured", async () => {
    const { t, order } = await placeOnline(5, 2);
    const gw = (await load(order.id)).razorpayOrderId!;
    fake.addPayment(gw, "captured", { amount: order.total });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.paid).toBeGreaterThanOrEqual(1);
    expect(await load(order.id)).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("does not cancel an order whose payment is authorized (money held, outcome open)", async () => {
    const { t, order } = await placeOnline(5, 2);
    fake.addPayment((await load(order.id)).razorpayOrderId!, "authorized", { amount: order.total });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.pending).toBeGreaterThanOrEqual(1);
    expect((await load(order.id)).status).toBe("awaiting_payment");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("treats abandoned ('created') and failed gateway attempts as unpaid and expires the order", async () => {
    const a = await placeOnline(5, 1);
    fake.addPayment((await load(a.order.id)).razorpayOrderId!, "created", { amount: a.order.total });
    const b = await placeOnline(5, 1);
    fake.addPayment((await load(b.order.id)).razorpayOrderId!, "failed", { amount: b.order.total });
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect((await load(a.order.id)).status).toBe("cancelled");
    expect((await load(b.order.id)).status).toBe("cancelled");
  });

  it("never cancels on a gateway answer it could not read", async () => {
    const { t, order } = await placeOnline(5, 2);
    fake.install();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.errors).toBeGreaterThanOrEqual(1);
    expect((await load(order.id)).status).toBe("awaiting_payment");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("skips attempts that never got a gateway reference (payments:reconcile owns those)", async () => {
    const t = await createInventoryVariant({ stock: 3 });
    const order = await createOrder({ ...customer, paymentMethod: "razorpay", items: [{ variantId: t.variantId, quantity: 1 }] });
    await db.order.update({ where: { id: order.id }, data: { createdAt: old() } });
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect((await load(order.id)).status).toBe("awaiting_payment");
  });

  it("does not expire pay-on-delivery orders (their hold lasts until staff act)", async () => {
    setMode("request_only");
    const t = await createInventoryVariant({ stock: 3 });
    const order = await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 2 }] });
    await db.order.update({ where: { id: order.id }, data: { createdAt: old(60 * 24 * 7) } });
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect((await load(order.id)).status).toBe("pending_confirmation");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("expires mock-mode orders without any network call, and ignores orders from another mode", async () => {
    setMode("mock");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in mock mode"); }));
    const t = await createInventoryVariant({ stock: 3 });
    const order = await createOrder({ ...customer, paymentMethod: "razorpay", items: [{ variantId: t.variantId, quantity: 1 }] });
    await db.order.update({ where: { id: order.id }, data: { createdAt: old() } });
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect((await load(order.id)).status).toBe("cancelled");
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 });
    // an order created under razorpay_test is not touched while the server is in mock mode
    setMode("razorpay_test");
    fake = new FakeRazorpay().install();
    const other = await placeOnline(5, 1);
    setMode("mock");
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect((await load(other.order.id)).status).toBe("awaiting_payment");
  });

  it("a second run changes nothing (no double release)", async () => {
    const { t, order } = await placeOnline(5, 2);
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    const before = await movements(t.variantId);
    await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(await movements(t.variantId)).toHaveLength(before.length);
    expect((await load(order.id)).events).toHaveLength(1);
  });

  it("an order paid between selection and cancellation is left alone (stale state)", async () => {
    const { t, order } = await placeOnline(5, 1);
    const gateway = globalThis.fetch;
    // while the sweep waits on the gateway, the customer's verify call wins the race and the order becomes paid
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      await db.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'paid', "paymentStatus" = 'paid' WHERE "id" = '${order.id}'`);
      await db.$executeRawUnsafe(`UPDATE "Payment" SET "status" = 'paid' WHERE "orderId" = '${order.id}'`);
      return gateway(...args);
    }));
    const s = await expireUnpaidOrders(config(), { windowMinutes: 60 });
    expect(s.expired).toBe(0);
    expect(await load(order.id)).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 }); // the sale keeps its hold
  });

  it("also removes idempotency keys past their 24 h life", async () => {
    const t = await createInventoryVariant({ stock: 3 });
    const order = await createOrder({ ...customer, paymentMethod: "razorpay", items: [{ variantId: t.variantId, quantity: 1 }] }, { idempotency: { keyHash: "h".repeat(64), requestHash: "r".repeat(64) } });
    await db.idempotencyKey.update({ where: { orderId: order.id }, data: { expiresAt: old(10) } });
    const s = await expireUnpaidOrders(config());
    expect(s.keysDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.idempotencyKey.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("GET /api/internal/orders/expire", () => {
  const call = (auth?: string) => expireRoute(new Request("http://localhost/api/internal/orders/expire", { headers: auth ? { authorization: auth } : {} }));

  it("does not exist unless CRON_SECRET is configured with 24+ characters", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(`Bearer ${CRON}`)).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "too-short");
    expect((await call("Bearer too-short")).status).toBe(404);
  });

  it("rejects a missing or wrong bearer token with 401 and runs nothing", async () => {
    vi.stubEnv("CRON_SECRET", CRON);
    const { order } = await placeOnline(5, 1);
    for (const bad of [undefined, "Bearer wrong", CRON, `bearer ${CRON}`, `Bearer ${CRON} `.trimEnd() + "x"]) expect((await call(bad)).status).toBe(401);
    expect((await load(order.id)).status).toBe("awaiting_payment");
  });

  it("with the right token runs the sweep and returns counts only", async () => {
    vi.stubEnv("CRON_SECRET", CRON);
    const { order } = await placeOnline(5, 1);
    const res = await call(`Bearer ${CRON}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["checked", "errors", "expired", "keysDeleted", "ok", "paid", "pending", "skipped"]);
    expect(body.expired).toBeGreaterThanOrEqual(1);
    expect((await load(order.id)).status).toBe("cancelled");
  });

  it("answers 503 when payments are misconfigured", async () => {
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("PAYMENT_MODE", "not-a-mode");
    expect((await call(`Bearer ${CRON}`)).status).toBe(503);
  });
});
