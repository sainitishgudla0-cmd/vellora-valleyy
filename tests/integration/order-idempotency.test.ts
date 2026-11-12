/** M3-T4/T5: Idempotency-Key replay and order-number collision retry through the real route and Postgres. */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder, MAX_ORDER_NUMBER_ATTEMPTS, OrderError } from "@/lib/orders";
import { updateVariantInventory } from "@/lib/inventory/adjust";
import { findLedgerDrift } from "@/lib/inventory/ledger";
import { FakeRazorpay, TEST_KEY_ID, TEST_KEY_SECRET } from "../support/fake-razorpay";
import { cleanupInventoryFixtures, createInventoryVariant, customer, variantState } from "../support/inventory";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);
import { POST } from "@/app/api/orders/route";

const KEY = () => `idem-${crypto.randomUUID()}`;
const post = async (body: unknown, key?: string) => {
  const res = await POST(new Request("http://localhost/api/orders", { method: "POST", headers: key === undefined ? {} : { "Idempotency-Key": key }, body: JSON.stringify(body) }));
  return { status: res.status, replayed: res.headers.get("Idempotent-Replayed"), body: (await res.json()) as Record<string, any> };
};
const cod = (variantId: string, quantity = 1) => ({ ...customer, paymentMethod: "cod" as const, items: [{ variantId, quantity }] });
const ordersFor = (variantId: string) => db.order.count({ where: { items: { some: { variantId } } } });
let fake: FakeRazorpay;

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "request_only");
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
  rate.rateLimit.mockResolvedValue(true);
  fake = new FakeRazorpay().install();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  expect(await findLedgerDrift()).toEqual([]);
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("Idempotency-Key", () => {
  it("replays the first response for the same key and body: one order, one reservation", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const key = KEY();
    const first = await post(cod(t.variantId, 2), key);
    const second = await post(cod(t.variantId, 2), key);
    expect(first.status).toBe(201);
    expect(first.replayed).toBeNull();
    expect(second).toMatchObject({ status: 201, replayed: "true", body: first.body });
    expect(await ordersFor(t.variantId)).toBe(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
  });

  it("treats a reordered but equal body as the same request", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const key = KEY();
    const a = await post(cod(t.variantId), key);
    const reordered = Object.fromEntries(Object.entries(cod(t.variantId)).reverse());
    const b = await post(reordered, key);
    expect(b).toMatchObject({ status: 201, replayed: "true", body: a.body });
  });

  it("refuses the same key with a different body (422) and creates nothing", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const key = KEY();
    await post(cod(t.variantId, 1), key);
    const other = await post(cod(t.variantId, 2), key);
    expect(other.status).toBe(422);
    expect(await ordersFor(t.variantId)).toBe(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 });
  });

  it("without a key every request is its own order (behaviour unchanged)", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const a = await post(cod(t.variantId));
    const b = await post(cod(t.variantId));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.order.number).not.toBe(b.body.order.number);
    expect(Object.keys(a.body)).toEqual(["order"]);
  });

  it.each(["short", "has spaces in it 1234567890", "bad/char/in/key/1234567890", "x".repeat(129), ""])("rejects a malformed key %#", async (bad) => {
    const t = await createInventoryVariant({ stock: 1 });
    expect((await post(cod(t.variantId), bad)).status).toBe(400);
    expect(await ordersFor(t.variantId)).toBe(0);
  });

  it("parallel requests with one key create exactly one order; the others replay or are told to retry", async () => {
    const t = await createInventoryVariant({ stock: 10 });
    const key = KEY();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(cod(t.variantId, 2), key)));
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.order.number)).size).toBe(1);
    expect(await ordersFor(t.variantId)).toBe(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 });
    const retry = await post(cod(t.variantId, 2), key); // once the first request finished, a retry always gets the stored answer
    expect(retry).toMatchObject({ status: 201, replayed: "true", body: ok[0].body });
  });

  it("a refused order (out of stock) does not consume the key", async () => {
    const t = await createInventoryVariant({ stock: 1 });
    const key = KEY();
    expect((await post(cod(t.variantId, 3), key)).status).toBe(409);
    expect(await db.idempotencyKey.count({ where: { orderId: null } })).toBe(0);
    await updateVariantInventory({ variantId: t.variantId, actor: { type: "admin", id: "admin" }, stockAdjust: { delta: 5, reason: "Restock" } });
    expect((await post(cod(t.variantId, 3), key)).status).toBe(201); // same key, same body, now possible
  });

  it("stores only a hash of the key, linked to the order, expiring in about 24 hours", async () => {
    const t = await createInventoryVariant({ stock: 2 });
    const key = KEY();
    const r = await post(cod(t.variantId), key);
    const rows = await db.idempotencyKey.findMany({ where: { order: { number: r.body.order.number } } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.responseStatus).toBe(201);
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  it("an expired key can be used again (and the stale row is replaced)", async () => {
    const t = await createInventoryVariant({ stock: 5 });
    const key = KEY();
    const first = await post(cod(t.variantId), key);
    await db.idempotencyKey.updateMany({ where: { order: { number: first.body.order.number } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const second = await post(cod(t.variantId), key);
    expect(second.status).toBe(201);
    expect(second.replayed).toBeNull();
    expect(second.body.order.number).not.toBe(first.body.order.number);
  });

  it("a definite gateway failure is stored and replayed without calling the gateway again", async () => {
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
    vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
    const t = await createInventoryVariant({ stock: 3 });
    fake.createBehaviour = "http400";
    const body = { ...customer, paymentMethod: "razorpay" as const, items: [{ variantId: t.variantId, quantity: 1 }] };
    const key = KEY();
    const first = await post(body, key);
    expect(first.status).toBe(502);
    const calls = fake.calls.length;
    const again = await post(body, key);
    expect(again).toMatchObject({ status: 502, replayed: "true", body: first.body });
    expect(fake.calls.length).toBe(calls);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 0 }); // cancelled by the failure path, hold released
  });

  it("an unknown gateway outcome is replayed with the same order number, not a second order", async () => {
    vi.stubEnv("PAYMENT_MODE", "razorpay_test");
    vi.stubEnv("RAZORPAY_KEY_ID", TEST_KEY_ID);
    vi.stubEnv("RAZORPAY_KEY_SECRET", TEST_KEY_SECRET);
    const t = await createInventoryVariant({ stock: 3 });
    fake.createBehaviour = "timeout";
    const body = { ...customer, paymentMethod: "razorpay" as const, items: [{ variantId: t.variantId, quantity: 1 }] };
    const key = KEY();
    const first = await post(body, key);
    expect(first.status).toBe(502);
    expect(first.body.orderNumber).toMatch(/^VV-/);
    const again = await post(body, key);
    expect(again).toMatchObject({ status: 502, replayed: "true", body: first.body });
    expect(await ordersFor(t.variantId)).toBe(1);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 }); // still held: the order awaits reconciliation
  });
});

describe("order-number collisions (M3-T5)", () => {
  const ymd = () => {
    const d = new Date();
    return `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  };
  const real = crypto.randomBytes.bind(crypto);
  /** Makes the order-number suffix (the only 3-byte request) collide for the first `times` calls. */
  const collide = (times: number) => {
    let n = 0;
    return vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) => (size === 3 && n++ < times ? Buffer.from([0xee, 0xee, 0xee]) : real(size))) as typeof crypto.randomBytes);
  };
  const taken = () => `VV-${ymd()}-EEEEEE`;
  const clear = () => db.order.deleteMany({ where: { number: taken() } });

  beforeEach(async () => {
    await clear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await clear();
  });

  async function occupyNumber() {
    const t = await createInventoryVariant({ stock: 50 });
    const spy = collide(1);
    const first = await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] });
    spy.mockRestore();
    expect(first.number).toBe(taken());
    return t;
  }

  it("regenerates the number and succeeds when the first tries collide", async () => {
    const t = await occupyNumber();
    const spy = collide(MAX_ORDER_NUMBER_ATTEMPTS - 1);
    const o = await createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] });
    spy.mockRestore();
    expect(o.number).not.toBe(taken());
    expect(o.number).toMatch(/^VV-\d{6}-[0-9A-F]{6}$/);
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 2 }); // the failed attempts left no hold behind
  });

  it("gives up after the maximum attempts with a retryable error and leaves nothing behind", async () => {
    const t = await occupyNumber();
    const spy = collide(MAX_ORDER_NUMBER_ATTEMPTS);
    await expect(createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] })).rejects.toMatchObject({ status: 503 });
    spy.mockRestore();
    expect(await variantState(t.variantId)).toMatchObject({ reserved: 1 });
    expect(await ordersFor(t.variantId)).toBe(1);
  });

  it("does not retry (or mask) other failures", async () => {
    const t = await createInventoryVariant({ stock: 0 });
    await expect(createOrder({ ...customer, paymentMethod: "cod", items: [{ variantId: t.variantId, quantity: 1 }] })).rejects.toBeInstanceOf(OrderError);
  });
});
