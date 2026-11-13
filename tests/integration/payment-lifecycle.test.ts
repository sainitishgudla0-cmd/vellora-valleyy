/**
 * M10-T3/T6: the whole online-payment lifecycle through real routes and Postgres with the fake gateway:
 * checkout -> (browser drops) -> webhook or reconciliation -> paid -> admin refund -> refund webhook.
 * The Razorpay-hosted pages and real test keys cannot run here; docs/RELEASE.md has the test-mode runbook for a preview.
 */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reconcileGateway, STALE_AWAITING_MS } from "@/lib/payments/reconcile";
import { resolvePaymentConfig } from "@/lib/env/payment-config";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET, TEST_WEBHOOK_SECRET } from "../support/fake-razorpay";
import { cleanupFixtures, createRazorpayOrderWithAttempt } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as webhookRoute } from "@/app/api/payments/razorpay/webhook/route";
import { POST as refundRoute } from "@/app/api/admin/orders/[id]/refunds/route";
import { GET as reconcileRoute } from "@/app/api/internal/payments/reconcile/route";

let fake: FakeRazorpay;
let variantId: string;
let owner: Awaited<ReturnType<typeof createTestAdmin>>;
const tag = Date.now().toString(36);
let seq = 0;
const customer = { customerName: "SMOKE TEST Lifecycle", email: "smoke.lifecycle@example.com", phone: "9876543210", addressLine1: "1 Test Street", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" };
const config = () => resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET } as unknown as NodeJS.ProcessEnv);

async function checkout() {
  const res = await createOrderRoute(new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ ...customer, paymentMethod: "razorpay", items: [{ variantId, quantity: 1 }] }) }));
  expect(res.status).toBe(201);
  const b = (await res.json()) as Record<string, any>;
  return { number: b.order.number as string, gw: b.payment.orderId as string, total: b.order.total as number };
}
async function webhook(event: string, payload: unknown) {
  const raw = JSON.stringify({ entity: "event", event, payload });
  const res = await webhookRoute(new Request("http://localhost/api/payments/razorpay/webhook", { method: "POST", headers: { "x-razorpay-event-id": `evt_${tag}_${++seq}`, "x-razorpay-signature": crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(raw).digest("hex") }, body: raw }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const entity = (p: { id: string; order_id: string | null; status: string; amount: number; currency: string }) => ({ payment: { entity: p } });
const load = (number: string) => db.order.findUniqueOrThrow({ where: { number }, include: { payments: true } });
const cron = (bearer?: string) => reconcileRoute(new Request("http://localhost/api/internal/payments/reconcile", { headers: bearer ? { authorization: bearer } : {} }));

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "razorpay_test");
  vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
  vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789abcdef");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.spyOn(console, "error").mockImplementation(() => {});
  rate.rateLimit.mockResolvedValue(true);
  fake = new FakeRazorpay().install();
  variantId ??= (await db.variant.findFirstOrThrow({ where: { inStock: true, product: { active: true } } })).id;
  owner ??= await createTestAdmin("owner");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.webhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${tag}` } } });
  await db.order.deleteMany({ where: { customerName: "SMOKE TEST Lifecycle" } });
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("end to end (fake gateway)", () => {
  it("checkout -> customer pays but the browser drops -> webhook pays the order -> refund by admin -> refund webhook", async () => {
    const c = await checkout();
    expect(await load(c.number)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    // the customer pays in the Razorpay window, then closes the tab: no /verify call ever happens
    const pay = fake.addPayment(c.gw, "captured", { amount: c.total });
    expect((await webhook("payment.captured", entity(pay))).body.outcome).toBe("paid");
    expect(await load(c.number)).toMatchObject({ status: "paid", paymentStatus: "paid", razorpayPaymentId: pay.id });

    const order = await load(c.number);
    const res = await refundRoute(new Request("http://localhost/x", { method: "POST", headers: { cookie: owner.cookie }, body: JSON.stringify({ reason: "Customer cancelled after payment", requestKey: `e2e-${tag}-1`, amountPaise: 10000 }) }), { params: Promise.resolve({ id: order.id }) });
    expect(res.status).toBe(201);
    const rfnd = [...fake.refunds.values()][0];
    expect(await load(c.number)).toMatchObject({ paymentStatus: "paid" }); // partial
    // the gateway also reports it (processed webhook): the ledger does not double
    await webhook("refund.processed", { refund: { entity: { id: rfnd.id, payment_id: pay.id, amount: rfnd.amount, currency: "INR", status: "processed", receipt: rfnd.receipt } } });
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    // refund the rest in the dashboard: adopted, order settles as refunded
    const rest = fake.addRefund(pay.id, c.total - 10000, "processed");
    await webhook("refund.processed", { refund: { entity: { id: rest.id, payment_id: pay.id, amount: rest.amount, currency: "INR", status: "processed", receipt: null } } });
    expect(await load(c.number)).toMatchObject({ paymentStatus: "refunded" });
    const ledger = await db.refund.findMany({ where: { orderId: order.id } });
    expect(ledger.reduce((n, r) => n + r.amount, 0)).toBe(c.total);
    // the ledger equals the gateway
    expect([...fake.refunds.values()].reduce((n, r) => n + r.amount, 0)).toBe(c.total);
  });
});

describe("reconciliation (M10-T3)", () => {
  it("a dropped browser AND a lost webhook still end paid within one cycle, and the cycle is idempotent", async () => {
    const c = await checkout();
    fake.addPayment(c.gw, "captured", { amount: c.total }); // captured at the gateway, nobody told us
    const before = await reconcileGateway(config()); // too recent: not asked about yet
    expect(before.swept).toBe(0);
    expect((await load(c.number)).paymentStatus).toBe("unpaid");
    const later = new Date(Date.now() + STALE_AWAITING_MS + 60_000);
    const s = await reconcileGateway(config(), { now: later });
    expect(s.swept).toBeGreaterThanOrEqual(1);
    expect(s.paid).toBeGreaterThanOrEqual(1);
    expect(await load(c.number)).toMatchObject({ status: "paid", paymentStatus: "paid" });
    const events = await db.orderEvent.count({ where: { order: { number: c.number } } });
    await reconcileGateway(config(), { now: new Date(later.getTime() + 3600_000) });
    expect(await db.orderEvent.count({ where: { order: { number: c.number } } })).toBe(events);
  });

  it("an order nobody paid is left alone (flag cleared), and does not hammer the gateway on every cycle", async () => {
    const c = await checkout();
    const later = new Date(Date.now() + STALE_AWAITING_MS + 60_000);
    await reconcileGateway(config(), { now: later });
    expect(await load(c.number)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    const calls = fake.calls.length;
    await reconcileGateway(config(), { now: new Date(later.getTime() + 60_000) }); // checked a minute ago: not swept again
    expect(fake.calls.length).toBe(calls);
  });

  it("a recorded orphan capture is never re-applied by reconciliation", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    const pay = fake.addPayment(f.providerOrderId!, "captured", { amount: f.order.total - 1 });
    await db.payment.create({ data: { orderId: f.order.id, provider: "razorpay", mode: "razorpay_test", providerOrderId: f.providerOrderId, providerPaymentId: pay.id, amount: pay.amount, status: "unpaid", needsReconciliation: true, reconcileReason: "amount_mismatch" } });
    await reconcileGateway(config(), { now: new Date(Date.now() + STALE_AWAITING_MS + 60_000) });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(await db.payment.findFirstOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ status: "unpaid", reconcileReason: "amount_mismatch" });
  });

  it("the scheduled route is 404 without CRON_SECRET, 401 on a wrong bearer, and returns counts only", async () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect((await cron("Bearer short")).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789abcdef");
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong-secret-wrong-secret-0123456789")).status).toBe(401);
    const ok = await cron("Bearer cron-secret-for-tests-0123456789abcdef");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, mode: "razorpay_test", refunds: expect.any(Object) });
    for (const v of Object.values(body)) expect(["boolean", "number", "string", "object"]).toContain(typeof v);
    vi.stubEnv("PAYMENT_MODE", "request_only");
    expect((await cron("Bearer cron-secret-for-tests-0123456789abcdef")).status).toBe(200); // no Razorpay mode: nothing to reconcile
  });
});
