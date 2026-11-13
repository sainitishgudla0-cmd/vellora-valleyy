/** M2-T6: admin PATCH through the real route, state machine and Postgres. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupFixtures, createFixtureOrder, createMockOrderWithAttempt, createRazorpayOrderWithAttempt } from "../support/mock-orders";

import { PATCH } from "@/app/api/admin/orders/[id]/route";

let admin: Awaited<ReturnType<typeof createTestAdmin>>;
let cookie: string | undefined;
const patch = async (id: string, body: unknown) => {
  const res = await PATCH(new Request("http://localhost/api/admin/orders/x", { method: "PATCH", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
const events = (orderId: string) => db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });

/** A pay-on-delivery order as /api/orders now creates it: request_only mode + request_only attempt. */
async function codOrder(status: "pending_confirmation" | "confirmed" | "dispatched" | "delivered" | "cancelled" = "confirmed", paymentStatus: "unpaid" | "paid" = "unpaid") {
  const order = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status, paymentStatus });
  await db.payment.create({ data: { orderId: order.id, provider: "request_only", mode: "request_only", amount: order.total, currency: "INR", status: paymentStatus } });
  return order;
}

beforeEach(async () => {
  admin ??= await createTestAdmin("owner");
  cookie = admin.cookie;
});
afterAll(async () => {
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("status transitions", () => {
  it("walks pay-on-delivery through confirm → dispatch → deliver, recording admin events with a default reason", async () => {
    const o = await codOrder("pending_confirmation");
    for (const status of ["confirmed", "dispatched", "delivered"]) expect((await patch(o.id, { status })).status).toBe(200);
    expect(await load(o.id)).toMatchObject({ status: "delivered", paymentStatus: "unpaid" }); // delivery never implies payment
    const ev = await events(o.id);
    expect(ev.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["pending_confirmation>confirmed", "confirmed>dispatched", "dispatched>delivered"]);
    expect(ev.every((e) => e.actorType === "admin" && e.actorId === admin.user.id && e.reason)).toBe(true);
  });

  it("an explicit reason is recorded", async () => {
    const o = await codOrder("pending_confirmation");
    await patch(o.id, { status: "confirmed", reason: "Called customer, stock available" });
    expect((await events(o.id))[0].reason).toBe("Called customer, stock available");
  });

  it.each([
    ["delivered", "pending_confirmation"],
    ["delivered", "cancelled"],
    ["cancelled", "confirmed"],
    ["confirmed", "awaiting_payment"],
    ["pending_confirmation", "delivered"],
    ["pending_confirmation", "dispatched"],
  ] as const)("invalid transition %s → %s is a 409 with no change and no event", async (from, to) => {
    const o = await codOrder(from);
    const r = await patch(o.id, { status: to });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("invalid_transition");
    expect((await load(o.id)).status).toBe(from);
    expect(await events(o.id)).toHaveLength(0);
  });

  it("an admin can never mark an order paid (not for pay on delivery, not for an awaiting online order)", async () => {
    const cod = await codOrder("confirmed");
    expect((await patch(cod.id, { status: "paid" })).status).toBe(409);
    const online = await createRazorpayOrderWithAttempt({});
    const r = await patch(online.order.id, { status: "paid", paymentStatus: "paid", reason: "customer says paid", paymentReference: "UPI-123456" });
    expect(r.status).toBe(409);
    expect(await load(online.order.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });
    expect(await events(online.order.id)).toHaveLength(0);
  });

  it("re-sending the current status is an idempotent no-op; an empty body too", async () => {
    const o = await codOrder("confirmed");
    expect((await patch(o.id, { status: "confirmed" })).status).toBe(200);
    expect((await patch(o.id, {})).status).toBe(200);
    expect(await events(o.id)).toHaveLength(0);
  });

  it("cancelling a paid order needs an explicit reason; an unpaid one does not", async () => {
    const paid = await codOrder("confirmed", "paid");
    const r = await patch(paid.id, { status: "cancelled" });
    expect(r.status).toBe(422);
    expect(r.body.fields.reason).toBeTruthy();
    expect((await load(paid.id)).status).toBe("confirmed");
    expect((await patch(paid.id, { status: "cancelled", reason: "Customer returned goods; refund to follow" })).status).toBe(200);
    const unpaid = await codOrder("confirmed");
    expect((await patch(unpaid.id, { status: "cancelled" })).status).toBe(200);
  });

  it("concurrent identical requests: one event, all succeed or no-op", async () => {
    const o = await codOrder("confirmed");
    const rs = await Promise.all(Array.from({ length: 6 }, () => patch(o.id, { status: "dispatched" })));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await events(o.id)).toHaveLength(1);
    expect((await load(o.id)).status).toBe("dispatched");
  });

  it("unauthorised → 401, unknown order → 404, bad value → 422, nothing written", async () => {
    const o = await codOrder("confirmed");
    cookie = undefined;
    expect((await patch(o.id, { status: "dispatched" })).status).toBe(401);
    cookie = admin.cookie;
    expect((await patch("does-not-exist", { status: "dispatched" })).status).toBe(404);
    expect((await patch(o.id, { status: "shipped" })).status).toBe(422);
    expect((await load(o.id)).status).toBe("confirmed");
    expect(await events(o.id)).toHaveLength(0);
  });
});

describe("manual payment confirmation (request-only orders)", () => {
  const confirm = (id: string, over: object = {}) => patch(id, { paymentStatus: "paid", reason: "Cash collected on delivery", paymentReference: "RCPT-2026-0001", ...over });

  it("needs a reason and a reference; with both it marks the payment and the attempt paid, status unchanged, one audited event", async () => {
    const o = await codOrder("delivered");
    expect((await confirm(o.id, { reason: undefined })).status).toBe(422);
    expect((await confirm(o.id, { paymentReference: undefined })).status).toBe(422);
    expect((await confirm(o.id, { paymentReference: "x" })).status).toBe(422);
    expect(await events(o.id)).toHaveLength(0);
    expect((await load(o.id)).paymentStatus).toBe("unpaid");

    expect((await confirm(o.id, { paymentReference: "  RCPT-" + o.number.slice(-6) + "  " })).status).toBe(200);
    const after = await load(o.id);
    expect(after).toMatchObject({ status: "delivered", paymentStatus: "paid" });
    expect(after.payments[0]).toMatchObject({ status: "paid", manualReference: `RCPT-${o.number.slice(-6)}`, provider: "request_only", providerPaymentId: null });
    const ev = await events(o.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "admin", actorId: admin.user.id, fromPaymentStatus: "unpaid", toPaymentStatus: "paid", reason: "Cash collected on delivery", paymentReference: `RCPT-${o.number.slice(-6)}`, fromStatus: "delivered", toStatus: "delivered" });
  });

  it("a repeat is an idempotent no-op", async () => {
    const o = await codOrder("confirmed");
    await confirm(o.id, { paymentReference: "RCPT-IDEMP-1" });
    expect((await confirm(o.id, { paymentReference: "RCPT-IDEMP-1" })).status).toBe(200);
    expect(await events(o.id)).toHaveLength(1);
  });

  it("one external reference cannot confirm two orders; the second is rolled back entirely", async () => {
    const a = await codOrder("confirmed");
    const b = await codOrder("confirmed");
    expect((await confirm(a.id, { paymentReference: "SHARED-REF-1" })).status).toBe(200);
    const r = await confirm(b.id, { paymentReference: "SHARED-REF-1" });
    expect(r).toMatchObject({ status: 409, body: { code: "reference_in_use" } });
    const after = await load(b.id);
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.payments[0]).toMatchObject({ status: "unpaid", manualReference: null });
    expect(await events(b.id)).toHaveLength(0);
  });

  it("cannot be combined with a status change, and never on a cancelled order", async () => {
    const o = await codOrder("dispatched");
    expect((await patch(o.id, { status: "delivered", paymentStatus: "paid", reason: "r", paymentReference: "RCPT-COMBO-1" })).status).toBe(409);
    expect(await load(o.id)).toMatchObject({ status: "dispatched", paymentStatus: "unpaid" });
    const c = await codOrder("cancelled");
    expect((await confirm(c.id, { paymentReference: "RCPT-CANCELLED-1" })).status).toBe(409);
    expect((await load(c.id)).paymentStatus).toBe("unpaid");
  });

  it.each([
    ["Razorpay order", async () => (await createRazorpayOrderWithAttempt({})).order],
    ["mock order", async () => (await createMockOrderWithAttempt()).order],
    ["legacy order (mode NULL)", async () => (await createRazorpayOrderWithAttempt({ mode: null })).order],
  ])("is refused for a %s", async (_n, make) => {
    const o = await make();
    const r = await confirm(o.id, { paymentReference: "RCPT-NOPE-" + o.number.slice(-5) });
    expect(r).toMatchObject({ status: 409, body: { code: "payment_edit_not_allowed" } });
    expect(await load(o.id)).toMatchObject({ paymentStatus: "unpaid" });
    expect(await events(o.id)).toHaveLength(0);
  });

  it("an order with no payment record cannot be edited (reconcile manually)", async () => {
    const o = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "confirmed" });
    expect(await confirm(o.id, { paymentReference: "RCPT-NOREC-1" })).toMatchObject({ status: 409, body: { code: "no_payment_record" } });
  });

  it("other payment edits are refused (unpaid→failed, unpaid→refunded, paid→unpaid)", async () => {
    const o = await codOrder("confirmed");
    for (const paymentStatus of ["failed", "refunded"]) expect((await patch(o.id, { paymentStatus, reason: "r" })).status).toBe(409);
    const paid = await codOrder("confirmed", "paid");
    expect((await patch(paid.id, { paymentStatus: "unpaid", reason: "r" })).status).toBe(409);
    expect((await patch(paid.id, { paymentStatus: "failed", reason: "r" })).status).toBe(409);
  });
});

describe("recording refunds made outside the system", () => {
  it("paid → refunded needs a reason, updates the attempt and records the event (request-only and gateway orders)", async () => {
    const cod = await codOrder("delivered", "paid");
    expect((await patch(cod.id, { paymentStatus: "refunded" })).status).toBe(422);
    expect((await patch(cod.id, { paymentStatus: "refunded", reason: "Refunded in cash at the counter" })).status).toBe(200);
    expect(await load(cod.id)).toMatchObject({ paymentStatus: "refunded" });
    expect((await load(cod.id)).payments[0].status).toBe("refunded");
    expect((await events(cod.id))[0]).toMatchObject({ fromPaymentStatus: "paid", toPaymentStatus: "refunded", actorType: "admin", paymentReference: null });
    // a refunded payment is terminal
    expect((await patch(cod.id, { paymentStatus: "paid", reason: "oops", paymentReference: "RCPT-AGAIN-1" })).status).toBe(409);

    const rz = await createRazorpayOrderWithAttempt({ status: "paid", paymentStatus: "paid" });
    await db.payment.update({ where: { id: rz.attempt.id }, data: { status: "paid", providerPaymentId: "pay_fixture_1" } });
    expect((await patch(rz.order.id, { paymentStatus: "refunded", reason: "Refunded from the Razorpay dashboard" })).status).toBe(200);
    expect((await load(rz.order.id)).payments[0].status).toBe("refunded");
  });
});

describe("atomicity", () => {
  it("if the OrderEvent insert fails, the Payment row and order stay unpaid; a retry then succeeds", async () => {
    const o = await codOrder("confirmed");
    const name = `vv_fail_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "OrderEvent" FOR EACH ROW WHEN (NEW."orderId" = '${o.id}') EXECUTE FUNCTION ${name}()`);
    try {
      await expect(patch(o.id, { paymentStatus: "paid", reason: "Cash", paymentReference: "RCPT-ATOMIC-1" })).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "OrderEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    const after = await load(o.id);
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.payments[0]).toMatchObject({ status: "unpaid", manualReference: null });
    expect((await patch(o.id, { paymentStatus: "paid", reason: "Cash", paymentReference: "RCPT-ATOMIC-1" })).status).toBe(200);
  });
});

describe("database constraints behind manual confirmation", () => {
  it("only request-only attempts can carry a manual reference", async () => {
    const f = await createRazorpayOrderWithAttempt({});
    await expect(db.payment.update({ where: { id: f.attempt.id }, data: { manualReference: "RCPT-DB-1" } })).rejects.toThrow(/Payment_manual_reference_request_only_check/);
    const m = await createMockOrderWithAttempt();
    await expect(db.payment.update({ where: { id: m.attempt.id }, data: { manualReference: "RCPT-DB-2" } })).rejects.toThrow(/Payment_manual_reference_request_only_check/);
  });
});
