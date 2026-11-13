/** M2-T4 against a real Postgres: the real route handler, mock provider, state machine and constraints. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { confirmBody, cleanupFixtures, createFixtureOrder, createMockOrderWithAttempt } from "../support/mock-orders";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST } from "@/app/api/payments/mock/confirm/route";

const KEY = "test-only-mock-confirm-key-0123456789";
const fetchSpy = vi.fn(async () => { throw new Error("network call attempted"); });

const post = async (body: unknown, headers: Record<string, string> = { "x-mock-confirm-key": KEY }) => {
  const res = await POST(new Request("http://localhost/api/payments/mock/confirm", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const state = async (f: Awaited<ReturnType<typeof createMockOrderWithAttempt>>) => ({
  order: await db.order.findUniqueOrThrow({ where: { id: f.order.id }, select: { status: true, paymentStatus: true, razorpayPaymentId: true, razorpayOrderId: true } }),
  payment: await db.payment.findUniqueOrThrow({ where: { id: f.attempt.id }, select: { status: true, providerPaymentId: true } }),
  events: await db.orderEvent.findMany({ where: { orderId: f.order.id } }),
});

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "mock");
  vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", KEY);
  rate.rateLimit.mockResolvedValue(true);
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupFixtures();
  await db.$disconnect();
});

describe("POST /api/payments/mock/confirm (real database)", () => {
  it("confirms a mock order: order paid, payment paid, one system event, no gateway ids, no network", async () => {
    const f = await createMockOrderWithAttempt();
    const r = await post(confirmBody(f));
    expect(r).toMatchObject({ status: 200, body: { ok: true, mock: true, label: "MOCK — no money moved" } });
    const s = await state(f);
    expect(s.order).toEqual({ status: "paid", paymentStatus: "paid", razorpayPaymentId: null, razorpayOrderId: null });
    expect(s.payment).toEqual({ status: "paid", providerPaymentId: f.proof.providerPaymentId });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ fromStatus: "awaiting_payment", toStatus: "paid", fromPaymentStatus: "unpaid", toPaymentStatus: "paid", actorType: "system", actorId: "mock-provider" });
    expect(s.events[0].reason).toContain("no money moved");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeat returns success and writes nothing more", async () => {
    const f = await createMockOrderWithAttempt();
    expect((await post(confirmBody(f))).status).toBe(200);
    const again = await post(confirmBody(f));
    expect(again).toMatchObject({ status: 200, body: { ok: true, alreadyConfirmed: true } });
    expect((await state(f)).events).toHaveLength(1);
  });

  it("idempotent repeat still works after the order moved on (dispatched)", async () => {
    const f = await createMockOrderWithAttempt();
    await post(confirmBody(f));
    await db.order.update({ where: { id: f.order.id }, data: { status: "dispatched" } });
    expect((await post(confirmBody(f))).body).toMatchObject({ alreadyConfirmed: true });
  });

  it("concurrent identical confirmations: exactly one event, all callers get a success", async () => {
    const f = await createMockOrderWithAttempt();
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(confirmBody(f))));
    expect(rs.map((r) => `${r.status}:${JSON.stringify(r.body)}`)).toEqual(rs.map(() => expect.stringMatching(/^200:/)));
    expect(rs.filter((r) => !r.body.alreadyConfirmed)).toHaveLength(1);
    const s = await state(f);
    expect(s.events).toHaveLength(1);
    expect(s.payment.status).toBe("paid");
    expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
  });

  it("a cancelled order can never become paid; nothing changes", async () => {
    const f = await createMockOrderWithAttempt({ status: "cancelled" });
    const r = await post(confirmBody(f));
    expect(r.status).toBe(409);
    const s = await state(f);
    expect(s.order).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect(s.payment.status).toBe("unpaid");
    expect(s.events).toHaveLength(0);
  });

  it("cancel racing with confirm: never both applied", async () => {
    const f = await createMockOrderWithAttempt();
    const { transitionOrder } = await import("@/lib/orders/state-machine");
    const [a, b] = await Promise.all([post(confirmBody(f)), transitionOrder({ orderId: f.order.id, from: "awaiting_payment", to: "cancelled", actor: { type: "system" }, reason: "race" })]);
    const s = await state(f);
    if (b.ok) {
      expect(a.status).toBe(409);
      expect(s.order.status).toBe("cancelled");
      expect(s.payment.status).toBe("unpaid");
    } else {
      expect(a.status).toBe(200);
      expect(s.order.status).toBe("paid");
    }
    expect(s.events).toHaveLength(1);
  });

  it("rejects an invalid signature, a forged payment id and a payment id for another order, with no writes", async () => {
    const f = await createMockOrderWithAttempt();
    const g = await createMockOrderWithAttempt();
    for (const over of [{ signature: "0".repeat(64) }, { providerPaymentId: "mock_pay_forged" }, { providerPaymentId: g.proof.providerPaymentId, signature: g.proof.signature }]) {
      expect((await post({ ...confirmBody(f), ...over })).status).toBe(400);
    }
    const s = await state(f);
    expect(s.order.status).toBe("awaiting_payment");
    expect(s.payment.status).toBe("unpaid");
    expect(s.events).toHaveLength(0);
  });

  it("a proof for order A cannot confirm order B even with B's token", async () => {
    const a = await createMockOrderWithAttempt();
    const b = await createMockOrderWithAttempt();
    const r = await post({ ...confirmBody(b), providerOrderId: a.providerOrderId, providerPaymentId: a.proof.providerPaymentId, signature: a.proof.signature });
    expect(r.status).toBe(404); // no such attempt on B
    expect((await state(a)).order.status).toBe("awaiting_payment");
    expect((await state(b)).order.status).toBe("awaiting_payment");
  });

  it("wrong or missing order token → 404 and no writes", async () => {
    const f = await createMockOrderWithAttempt();
    expect((await post({ ...confirmBody(f), token: "wrong" })).status).toBe(404);
    expect((await state(f)).events).toHaveLength(0);
  });

  it("amount mismatch between attempt and order is a conflict, not a payment", async () => {
    const f = await createMockOrderWithAttempt({ attemptAmount: 999 });
    expect((await post(confirmBody(f))).status).toBe(409);
    const s = await state(f);
    expect(s.order.paymentStatus).toBe("unpaid");
    expect(s.payment.status).toBe("unpaid");
  });

  it("currency mismatch is a conflict", async () => {
    const f = await createMockOrderWithAttempt();
    await db.payment.update({ where: { id: f.attempt.id }, data: { currency: "USD" } });
    expect((await post(confirmBody(f))).status).toBe(409);
    expect((await state(f)).order.paymentStatus).toBe("unpaid");
  });

  it("a different payment id for an already-paid attempt is a conflict", async () => {
    const f = await createMockOrderWithAttempt();
    await post(confirmBody(f));
    await db.payment.update({ where: { id: f.attempt.id }, data: { providerPaymentId: "mock_pay_other" } });
    expect((await post(confirmBody(f))).status).toBe(409);
  });

  it.each([
    ["request-only (COD)", { paymentMethod: "cod" as const, paymentMode: "request_only" as const, status: "pending_confirmation" as const }],
    ["Razorpay test", { paymentMode: "razorpay_test" as const }],
    ["Razorpay live", { paymentMode: "razorpay_live" as const }],
    ["legacy unclassified (NULL)", { paymentMode: null }],
  ])("refuses to confirm a %s order, even with a pending attempt and valid proof", async (_n, over) => {
    const f = await createMockOrderWithAttempt(over);
    expect((await post(confirmBody(f))).status).toBe(404);
    const s = await state(f);
    expect(s.order.paymentStatus).toBe("unpaid");
    expect(s.order.status).toBe((over as { status?: string }).status ?? "awaiting_payment");
    expect(s.events).toHaveLength(0);
  });

  it("a mock order without a mock attempt (only a Razorpay-provider row) cannot be confirmed", async () => {
    const order = await createFixtureOrder();
    const attempt = await db.payment.create({ data: { orderId: order.id, provider: "razorpay", mode: "razorpay_test", providerOrderId: "mock_order_x", amount: order.total, currency: "INR" } });
    const { mockProof } = await import("@/lib/payments/providers/mock");
    const p = mockProof("mock_order_x");
    const r = await post({ orderNumber: order.number, token: order.accessToken, providerOrderId: "mock_order_x", providerPaymentId: p.providerPaymentId, signature: p.signature });
    expect(r.status).toBe(404);
    expect((await db.payment.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("unpaid");
  });
});

describe("authorization and gating (real route, real database)", () => {
  it("missing or wrong confirm key → 401 and no writes; mode alone is not authorisation", async () => {
    const f = await createMockOrderWithAttempt();
    expect((await post(confirmBody(f), {})).status).toBe(401);
    expect((await post(confirmBody(f), { "x-mock-confirm-key": "x".repeat(KEY.length) })).status).toBe(401);
    expect((await state(f)).events).toHaveLength(0);
  });

  it("client-chosen provider/mode/amount/status fields are rejected (422)", async () => {
    const f = await createMockOrderWithAttempt();
    for (const extra of [{ provider: "razorpay" }, { mode: "razorpay_live" }, { amount: 1 }, { status: "paid" }]) {
      expect((await post({ ...confirmBody(f), ...extra })).status).toBe(422);
    }
    expect((await state(f)).order.status).toBe("awaiting_payment");
  });

  it("rate limiting applies before key checks", async () => {
    rate.rateLimit.mockResolvedValue(false);
    expect((await post({}, {})).status).toBe(429);
  });

  it.each([
    ["preview", { APP_ENV: "preview", VERCEL_ENV: "preview" }],
    ["production", { APP_ENV: "production", VERCEL_ENV: "production" }],
  ])("404 in %s even when mock mode and the key are forced", async (_n, env) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const f = await createMockOrderWithAttempt();
    expect((await post(confirmBody(f))).status).toBe(404);
    expect((await state(f)).events).toHaveLength(0);
  });

  it.each(["request_only", "razorpay_test"])("404 when the server mode is %s", async (mode) => {
    vi.stubEnv("PAYMENT_MODE", mode);
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_abc");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "fake_secret");
    const f = await createMockOrderWithAttempt();
    expect((await post(confirmBody(f))).status).toBe(404);
  });

  it("404 when no confirm key is configured (feature absent)", async () => {
    vi.stubEnv("MOCK_PAYMENT_CONFIRM_KEY", "");
    const f = await createMockOrderWithAttempt();
    expect((await post(confirmBody(f), {})).status).toBe(404);
  });

  it("does not log tokens, signatures or customer details on conflict", async () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await createMockOrderWithAttempt({ status: "cancelled" });
    await post(confirmBody(f));
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain(f.order.number);
    for (const secret of [f.token, f.proof.signature, "9876543210", "smoke.mock@example.com", KEY]) expect(logged).not.toContain(secret);
  });
});

describe("transaction atomicity (injected database failures)", () => {
  const withTrigger = async (table: string, orderCol: string, orderId: string, fn: () => Promise<void>) => {
    const name = `vv_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW WHEN (NEW."${orderCol}" = '${orderId}') EXECUTE FUNCTION ${name}()`);
    try { await fn(); } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  };

  it("if the OrderEvent insert fails, the Payment update and order change roll back", async () => {
    const f = await createMockOrderWithAttempt();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTrigger("OrderEvent", "orderId", f.order.id, async () => {
      await expect(post(confirmBody(f))).rejects.toThrow();
    });
    const s = await state(f);
    expect(s.payment).toEqual({ status: "unpaid", providerPaymentId: null });
    expect(s.order).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(s.events).toHaveLength(0);
    // and the system recovers: a retry succeeds
    expect((await post(confirmBody(f))).status).toBe(200);
  });

  it("if the order update fails, the already-applied Payment update rolls back", async () => {
    const f = await createMockOrderWithAttempt();
    await withTrigger("Order", "id", f.order.id, async () => {
      await expect(post(confirmBody(f))).rejects.toThrow();
    });
    const s = await state(f);
    expect(s.payment).toEqual({ status: "unpaid", providerPaymentId: null });
    expect(s.order).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(s.events).toHaveLength(0);
  });
});
