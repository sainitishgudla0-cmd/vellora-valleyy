/** M2-T2 against a real Postgres: atomic transitions, event history, concurrency. */
import { afterAll, describe, expect, it } from "vitest";
import type { OrderStatus, PaymentMethod, PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/state-machine";

const PREFIX = "VV-SM-";
let seq = 0;
async function makeOrder(status: OrderStatus, paymentMethod: PaymentMethod = "cod", paymentStatus: PaymentStatus = "unpaid") {
  const n = `${PREFIX}${Date.now()}-${seq++}`;
  return db.order.create({
    data: {
      number: n, accessToken: `tok-${n}`, status, paymentMethod, paymentStatus,
      customerName: "SMOKE TEST SM", email: "smoke.sm@example.com", phone: "9876543210", addressLine1: "1 Test Street",
      city: "Anantapur", state: "Andhra Pradesh", pincode: "515001", subtotal: 1000, deliveryFee: 50, total: 1050,
    },
  });
}
const events = (orderId: string) => db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
const reload = (id: string) => db.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true, razorpayPaymentId: true } });

afterAll(async () => {
  await db.order.deleteMany({ where: { number: { startsWith: PREFIX } } }); // cascades to OrderEvent
  await db.$disconnect();
});

describe("transitionOrder (real database)", () => {
  it("pay-on-delivery request → confirmed → dispatched → delivered stays unpaid and records history", async () => {
    const o = await makeOrder("pending_confirmation");
    const admin = { type: "admin" as const, id: "admin" };
    for (const [from, to] of [["pending_confirmation", "confirmed"], ["confirmed", "dispatched"], ["dispatched", "delivered"]] as const) {
      const r = await transitionOrder({ orderId: o.id, from, to, actor: admin, reason: `step ${to}` });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect(await reload(o.id)).toMatchObject({ status: "delivered", paymentStatus: "unpaid" });
    const ev = await events(o.id);
    expect(ev.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["pending_confirmation>confirmed", "confirmed>dispatched", "dispatched>delivered"]);
    expect(ev[0]).toMatchObject({ actorType: "admin", actorId: "admin", reason: "step confirmed", fromPaymentStatus: null });
  });

  it("gateway marks an awaiting_payment order paid with its payment id, atomically with the event", async () => {
    const o = await makeOrder("awaiting_payment", "razorpay");
    const r = await transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: { type: "gateway" }, data: { razorpayPaymentId: "pay_SM" } });
    expect(r.ok).toBe(true);
    expect(await reload(o.id)).toEqual({ status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_SM" });
    expect((await events(o.id))[0]).toMatchObject({ fromPaymentStatus: "unpaid", toPaymentStatus: "paid", actorType: "gateway" });
  });

  it("rejects invalid transitions and disallowed actors without touching the order or history", async () => {
    const o = await makeOrder("pending_confirmation");
    expect(await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "delivered", actor: { type: "system" } })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: { type: "customer" } })).toMatchObject({ ok: false, code: "actor_not_allowed" });
    expect(await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: { type: "admin" } })).toMatchObject({ ok: false, code: "reason_required" });
    expect((await reload(o.id)).status).toBe("pending_confirmation");
    expect(await events(o.id)).toHaveLength(0);
  });

  it("a stale caller loses: no change, no event, current state reported", async () => {
    const o = await makeOrder("cancelled");
    const r = await transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "paid", actor: { type: "gateway" } });
    expect(r).toMatchObject({ ok: false, code: "stale_state", current: { status: "cancelled", paymentStatus: "unpaid" } });
    expect(await events(o.id)).toHaveLength(0);
  });

  it("payment must also match: a paid payment cannot be marked paid again", async () => {
    const o = await makeOrder("awaiting_payment", "razorpay", "paid");
    const r = await transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: { type: "gateway" } });
    expect(r).toMatchObject({ ok: false, code: "stale_state" });
    expect(await events(o.id)).toHaveLength(0);
  });

  it("unknown order → not_found", async () => {
    expect(await transitionOrder({ orderId: "does-not-exist", from: "confirmed", to: "dispatched", actor: { type: "system" } })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("only one of many concurrent identical transitions wins and exactly one event exists", async () => {
    const o = await makeOrder("awaiting_payment", "razorpay");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        transitionOrder({ orderId: o.id, from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: { type: "gateway" }, data: { razorpayPaymentId: `pay_${i}` } }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "stale_state")).toBe(true);
    const ev = await events(o.id);
    expect(ev).toHaveLength(1);
    expect((await reload(o.id)).razorpayPaymentId).toMatch(/^pay_\d$/);
  });

  it("competing cancel vs dispatch: exactly one outcome is recorded", async () => {
    const o = await makeOrder("confirmed");
    const [a, b] = await Promise.all([
      transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: { type: "admin" }, reason: "ship" }),
      transitionOrder({ orderId: o.id, from: "confirmed", to: "cancelled", actor: { type: "admin" }, reason: "cancel" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await events(o.id)).toHaveLength(1);
  });

  it("deleting a test order removes its events (cleanup scripts keep working)", async () => {
    const o = await makeOrder("pending_confirmation");
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "cancelled", actor: { type: "customer" }, reason: "x" });
    await db.order.delete({ where: { id: o.id } });
    expect(await db.orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });
});
