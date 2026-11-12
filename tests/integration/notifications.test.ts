/** M7-T5/T6: transactional outbox, templates in context, retries, concurrency, crash recovery and the "never reaches a real recipient" guarantees. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { transitionOrder } from "@/lib/orders/state-machine";
import { updateOrderAsAdmin } from "@/lib/orders/admin-update";
import { issueInvoice } from "@/lib/invoices/issue";
import { enqueueOutbox } from "@/lib/notify/outbox";
import { processOutbox, MAX_ATTEMPTS, CLAIM_TIMEOUT_MS } from "@/lib/notify/dispatch";
import { failNextMockSends, mockMailbox } from "@/lib/notify/provider";
import { cleanupAdminFixtures } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupWholesaleFixtures, makeBuyer, SHIPPING } from "../support/wholesale";
import { cleanupFulfilmentFixtures, fulfilmentEnv, notifyOn, placeCod, setRate, SHIP_TO_AP } from "../support/fulfilment";
import { cleanupFixtures, createFixtureOrder } from "../support/mock-orders";
import { priceQuote } from "@/lib/wholesale/quotes";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as retailOrder } from "@/app/api/orders/route";
import { GET as processRoute } from "@/app/api/internal/outbox/process/route";

const ADMIN = { type: "admin" as const, id: "t" };
const GATEWAY = { type: "gateway" as const, id: "g" };
let variantId: string;
const queued = (where: object = {}) => db.outboxMessage.findMany({ where, orderBy: { createdAt: "asc" } });
const templates = async () => (await queued()).map((m) => m.template);
const confirm = (id: string) => transitionOrder({ orderId: id, from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "ok" });

beforeEach(async () => {
  fulfilmentEnv();
  customerTestEnv();
  notifyOn();
  rate.rateLimit.mockResolvedValue(true);
  failNextMockSends(0);
  await cleanupFulfilmentFixtures();
  await setRate("0802", 500);
  variantId ??= (await createInventoryVariant({ tracked: false, price: 10500 })).variantId;
});
afterAll(async () => {
  await cleanupFulfilmentFixtures();
  await cleanupWholesaleFixtures();
  await cleanupFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("queueing (transactional, idempotent)", () => {
  it("is completely off by default: nothing is queued and nothing is sent", async () => {
    vi.stubEnv("NOTIFY_MODE", "");
    const o = await placeCod(variantId);
    await confirm(o.id);
    expect(await db.outboxMessage.count()).toBe(0);
    await db.outboxMessage.create({ data: { template: "order_placed", subjectType: "order", subjectId: o.id, dedupeKey: "leftover-1" } });
    expect(await processOutbox()).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0 });
    expect(mockMailbox).toHaveLength(0);
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { dedupeKey: "leftover-1" } })).status).toBe("pending"); // untouched
  });

  it("is never available in production or preview, even if mock is configured: nothing is queued or sent", async () => {
    for (const env of ["production", "preview"]) {
      vi.stubEnv("APP_ENV", env);
      vi.stubEnv("NOTIFY_MODE", "mock");
      expect(await enqueueOutbox(db, { template: "order_placed", subjectType: "order", subjectId: "x", dedupeKey: `prod-${env}` })).toBe(false);
      expect((await processOutbox()).claimed).toBe(0);
    }
    expect(await db.outboxMessage.count()).toBe(0);
    expect(mockMailbox).toHaveLength(0);
  });

  it("placing an order queues order_placed exactly once, also for a replayed Idempotency-Key", async () => {
    const body = { ...SHIP_TO_AP, paymentMethod: "cod", items: [{ variantId, quantity: 1 }] };
    const call = () => retailOrder(new Request("http://localhost/api/orders", { method: "POST", headers: { "Idempotency-Key": `notify-key-${Date.now()}-abcdefgh`, host: "localhost" }, body: JSON.stringify(body) }));
    const headers = { "Idempotency-Key": `notify-key-${Math.random().toString(36).slice(2)}-abcdefghij` };
    const mkReq = () => new Request("http://localhost/api/orders", { method: "POST", headers: { ...headers, host: "localhost" }, body: JSON.stringify(body) });
    void call;
    const a = await retailOrder(mkReq());
    const b = await retailOrder(mkReq());
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(a.status).toBe(201);
    expect(await templates()).toEqual(["order_placed"]);
  });

  it("each lifecycle change queues its own message, and a payment-only confirmation queues order_paid", async () => {
    const o = await placeCod(variantId);
    await confirm(o.id);
    await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN, reason: "shipped" });
    await transitionOrder({ orderId: o.id, from: "dispatched", to: "delivered", actor: ADMIN, reason: "done" });
    expect((await updateOrderAsAdmin({ orderId: o.id, paymentStatus: "paid", reason: "cash received", paymentReference: "RCPT-1001" })).ok).toBe(true);
    expect(await templates()).toEqual(["order_placed", "order_confirmed", "order_dispatched", "order_delivered", "order_paid"]);
    const c = await placeCod(variantId);
    await transitionOrder({ orderId: c.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "asked" });
    expect((await queued({ subjectId: c.id })).map((m) => m.template)).toEqual(["order_placed", "order_cancelled"]);
  });

  it("a gateway payment queues one order_paid; refused or stale transitions queue nothing", async () => {
    const f = await createFixtureOrder({ status: "awaiting_payment", paymentMode: "mock" });
    const r = await transitionOrder({ orderId: f.id, from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY });
    expect(r.ok).toBe(true);
    const again = await transitionOrder({ orderId: f.id, from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY });
    expect(again.ok).toBe(false);
    expect(await transitionOrder({ orderId: f.id, from: "paid", to: "confirmed", actor: ADMIN, reason: "x" })).toMatchObject({ ok: false });
    expect((await queued({ subjectId: f.id })).map((m) => m.template)).toEqual(["order_paid"]);
  });

  it("the message exists if and only if the change committed (an injected failure rolls both back)", async () => {
    const o = await placeCod(variantId);
    await db.outboxMessage.deleteMany({});
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION m7_outbox_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER m7_outbox_fail BEFORE INSERT ON "OutboxMessage" FOR EACH ROW EXECUTE FUNCTION m7_outbox_fail()`);
    try {
      await expect(confirm(o.id)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER m7_outbox_fail ON "OutboxMessage"`);
      await db.$executeRawUnsafe(`DROP FUNCTION m7_outbox_fail()`);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("pending_confirmation");
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
    expect(await db.outboxMessage.count()).toBe(0);
  });

  it("wholesale orders, quote pricing and invoices queue their messages", async () => {
    const buyer = await makeBuyer();
    const w = await createOrder({ ...SHIPPING, paymentMethod: "cod", items: [{ variantId, quantity: 2 }] }, { customerId: buyer.customerId, wholesale: { businessAccountId: buyer.account.id, priceLines: async (_t, l) => new Map(l.map((x) => [x.variant.id, 9000])) } });
    const q = await db.quote.create({ data: { number: `QT-NOTIFY-${Date.now()}`, businessAccountId: buyer.account.id, items: { create: [{ variantId, productName: "P", variantLabel: "250g", sku: "S", quantity: 5 }] } } });
    expect((await priceQuote(q.id, { items: [{ variantId, unitPrice: 9000 }] }, "t")).ok).toBe(true);
    await confirm(w.id);
    expect((await issueInvoice(w.id)).ok).toBe(true);
    expect(await templates()).toEqual(["order_placed", "quote_ready", "order_confirmed", "invoice_issued"]);
    expect((await queued({ subjectType: "quote" }))[0].subjectId).toBe(q.id);
  });
});

describe("delivery (mock provider: no network, no real recipients)", () => {
  it("renders from the database at send time and delivers to the order's email; the outbox itself holds no personal data", async () => {
    const o = await placeCod(variantId, { quantity: 2 });
    await confirm(o.id);
    await db.shipment.create({ data: { orderId: o.id, courier: "Delhivery", awb: "DL999888", trackingUrl: "https://track.example.com/DL999888", events: { create: { status: "created" } } } });
    await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN, reason: "shipped" });
    const s = await processOutbox();
    expect(s).toMatchObject({ claimed: 3, sent: 3, retried: 0, dead: 0 });
    expect(mockMailbox.map((m) => m.subject)).toEqual([`We received your order ${o.number}`, `Order ${o.number} is confirmed`, `Order ${o.number} is on its way`]);
    const placed = mockMailbox[0];
    expect(placed.to).toBe(o.email);
    expect(placed.text).toContain(`/order/${o.number}?t=${o.accessToken}`);
    expect(placed.text).toMatch(/Rs\. 210\.00/);
    const dispatched = mockMailbox[2];
    expect(dispatched.text).toMatch(/Courier: Delhivery[\s\S]*Tracking number: DL999888[\s\S]*https:\/\/track\.example\.com\/DL999888/);
    expect(dispatched.html).toContain('href="https://track.example.com/DL999888"');
    const rows = JSON.stringify(await queued());
    for (const secret of [o.email, o.accessToken, o.customerName, o.phone, o.addressLine1]) expect(rows, secret).not.toContain(secret);
    expect((await queued()).every((m) => m.status === "sent" && m.attempts === 1 && m.sentAt && m.lastError === null)).toBe(true);
    expect((await processOutbox()).claimed).toBe(0); // nothing is sent twice
  });

  it("never touches the network", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network call attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const o = await placeCod(variantId);
      await confirm(o.id);
      expect((await processOutbox()).sent).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("every template is delivered with its own content for the right event", async () => {
    const b = await makeBuyer();
    const o = await placeCod(variantId);
    await confirm(o.id);
    await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN, reason: "x" });
    await transitionOrder({ orderId: o.id, from: "dispatched", to: "delivered", actor: ADMIN, reason: "x" });
    const c = await placeCod(variantId);
    await transitionOrder({ orderId: c.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "x" });
    const q = await db.quote.create({ data: { number: `QT-TPL-${Date.now()}`, businessAccountId: b.account.id, items: { create: [{ variantId, productName: "P", variantLabel: "250g", sku: "S", quantity: 5 }] } } });
    await priceQuote(q.id, { items: [{ variantId, unitPrice: 9000 }] }, "t");
    await issueInvoice(o.id);
    await processOutbox({ limit: 100 });
    const subjects = mockMailbox.map((m) => m.subject);
    for (const needle of [/We received your order/, /is confirmed/, /on its way/, /was delivered/, /was cancelled/, /Your quote QT-TPL-\d+ is ready/, /Your tax invoice VV\/26-27\/\d{6}|Your tax invoice VV\/\d\d-\d\d\/\d{6}/]) expect(subjects.some((s) => needle.test(s)), String(needle)).toBe(true);
    expect(mockMailbox.find((m) => /Your quote/.test(m.subject))!.to).toBe(b.account.contactEmail);
  });
});

describe("retries and failure handling", () => {
  async function one() {
    const o = await placeCod(variantId);
    await db.outboxMessage.deleteMany({ where: { dedupeKey: { not: `order-placed:${o.id}` } } });
    return o;
  }

  it("a failing provider is retried with backoff and succeeds once, with exactly one mail delivered", async () => {
    await one();
    failNextMockSends(2);
    const t0 = new Date("2030-01-01T00:00:00Z");
    expect(await processOutbox({ now: t0 })).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
    let m = (await queued())[0];
    expect(m).toMatchObject({ status: "failed", attempts: 1, lastError: "provider_unavailable" });
    expect(m.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000);
    expect((await processOutbox({ now: new Date(t0.getTime() + 30_000) })).claimed).toBe(0); // not due yet
    expect(await processOutbox({ now: new Date(t0.getTime() + 61_000) })).toMatchObject({ retried: 1 });
    m = (await queued())[0];
    expect(m.attempts).toBe(2);
    expect(m.nextAttemptAt.getTime()).toBe(t0.getTime() + 61_000 + 5 * 60_000);
    expect(await processOutbox({ now: new Date(t0.getTime() + 7 * 60_000) })).toMatchObject({ sent: 1 });
    expect((await queued())[0]).toMatchObject({ status: "sent", attempts: 3, lastError: null });
    expect(mockMailbox).toHaveLength(1);
  });

  it("gives up after the maximum attempts (dead, kept for staff) and an operator can put it back", async () => {
    await one();
    failNextMockSends(100, "mailbox_full");
    let now = new Date("2030-01-01T00:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await processOutbox({ now });
      now = new Date(now.getTime() + 7 * 3600_000);
    }
    const m = (await queued())[0];
    expect(m).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lastError: "mailbox_full" });
    expect((await processOutbox({ now })).claimed).toBe(0); // dead messages are not retried by the job
    expect(mockMailbox).toHaveLength(0);
    failNextMockSends(0);
    await db.outboxMessage.update({ where: { id: m.id }, data: { status: "pending", attempts: 0, nextAttemptAt: now, lastError: null } });
    expect((await processOutbox({ now })).sent).toBe(1);
  });

  it("provider error text (which could contain the recipient) is reduced to a short code", async () => {
    const o = await one();
    failNextMockSends(1, `550 mailbox ${o.email} unavailable`);
    await processOutbox();
    expect((await queued())[0].lastError).toBe("send_failed");
  });

  it("parallel dispatchers send every message exactly once", async () => {
    for (let i = 0; i < 30; i++) await enqueueOutbox(db, { template: "order_confirmed", subjectType: "order", subjectId: (await placeCod(variantId)).id, dedupeKey: `bulk-${Date.now()}-${i}` });
    await db.outboxMessage.deleteMany({ where: { template: "order_placed" } });
    const results = await Promise.all(Array.from({ length: 5 }, () => processOutbox({ limit: 12 })));
    expect(results.reduce((s, r) => s + r.sent, 0)).toBe(30);
    expect(mockMailbox).toHaveLength(30);
    expect(new Set(mockMailbox.map((m) => m.idempotencyKey)).size).toBe(30);
    expect(await db.outboxMessage.count({ where: { status: "sent" } })).toBe(30);
  }, 60_000);

  it("a message stuck in 'sending' (crashed worker) is reclaimed after the timeout, not before", async () => {
    await one();
    const m = (await queued())[0];
    const t = new Date("2030-02-01T00:00:00Z");
    await db.outboxMessage.update({ where: { id: m.id }, data: { status: "sending", claimedAt: t } });
    expect((await processOutbox({ now: new Date(t.getTime() + CLAIM_TIMEOUT_MS - 1000) })).claimed).toBe(0);
    expect((await processOutbox({ now: new Date(t.getTime() + CLAIM_TIMEOUT_MS + 1000) })).sent).toBe(1);
  });

  it("drops (never sends) messages for erased customers, unknown templates and vanished subjects", async () => {
    const o = await placeCod(variantId);
    await db.outboxMessage.deleteMany({});
    await db.order.update({ where: { id: o.id }, data: { email: "erased@erased.invalid" } });
    await db.outboxMessage.createMany({ data: [
      { template: "order_placed", subjectType: "order", subjectId: o.id, dedupeKey: "d-erased" },
      { template: "no_such_template", subjectType: "order", subjectId: o.id, dedupeKey: "d-template" },
      { template: "order_placed", subjectType: "order", subjectId: "does-not-exist", dedupeKey: "d-gone" },
    ] });
    expect(await processOutbox()).toMatchObject({ claimed: 3, sent: 0, skipped: 3 });
    expect((await queued()).map((m) => [m.status, m.lastError]).sort()).toEqual([["dead", "no_recipient"], ["dead", "subject_missing"], ["dead", "unknown_template"]]);
    expect(mockMailbox).toHaveLength(0);
  });

  it("dedupe keys make queuing idempotent", async () => {
    const o = await placeCod(variantId);
    expect(await enqueueOutbox(db, { template: "order_placed", subjectType: "order", subjectId: o.id, dedupeKey: `order-placed:${o.id}` })).toBe(false); // already queued by createOrder
    expect(await enqueueOutbox(db, { template: "order_confirmed", subjectType: "order", subjectId: o.id, dedupeKey: "custom-1" })).toBe(true);
    expect(await enqueueOutbox(db, { template: "order_confirmed", subjectType: "order", subjectId: o.id, dedupeKey: "custom-1" })).toBe(false);
  });
});

describe("GET /api/internal/outbox/process (scheduled job)", () => {
  const SECRET = "test-only-cron-secret-0123456789abcdef";
  const call = (auth?: string) => processRoute(new Request("http://localhost/api/internal/outbox/process", { headers: auth ? { authorization: auth } : {} }));
  it("does not exist without CRON_SECRET, rejects a wrong bearer, and sends with the right one", async () => {
    await placeCod(variantId);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(404);
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const bad of [undefined, "Bearer wrong", SECRET]) expect((await call(bad)).status).toBe(401);
    expect(mockMailbox).toHaveLength(0);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, claimed: 1, sent: 1 });
    expect(mockMailbox).toHaveLength(1);
  });
});
