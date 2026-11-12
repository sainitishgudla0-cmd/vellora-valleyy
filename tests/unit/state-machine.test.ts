import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentStatus, type OrderActorType } from "@prisma/client";

const tx = vi.hoisted(() => ({
  order: { updateMany: vi.fn(), findUnique: vi.fn() },
  orderEvent: { create: vi.fn() },
}));
const dbMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  order: { updateMany: vi.fn(), update: vi.fn() },
  orderEvent: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { ORDER_TRANSITIONS, PAYMENT_TRANSITIONS, canTransitionOrder, canTransitionPayment, transitionOrder, validateTransition } from "@/lib/orders/state-machine";

const ORDER = Object.values(OrderStatus);
const PAY = Object.values(PaymentStatus);
const ADMIN = { type: "admin" as const, id: "admin" };
const SYSTEM = { type: "system" as const };
const GATEWAY = { type: "gateway" as const };

/** The expected graph, written out independently of the implementation. */
const EXPECTED_ORDER: Record<string, string[]> = {
  pending_confirmation: ["confirmed", "cancelled"],
  awaiting_payment: ["paid", "cancelled"],
  confirmed: ["dispatched", "cancelled"],
  paid: ["dispatched", "cancelled"],
  dispatched: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};
const EXPECTED_PAYMENT: Record<string, string[]> = { unpaid: ["paid", "failed"], failed: ["paid", "unpaid"], paid: ["refunded"], refunded: [] };

describe("transition tables cover every status", () => {
  it("has an entry for every enum value and only enum values", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER].sort());
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAY].sort());
    for (const targets of Object.values(ORDER_TRANSITIONS)) for (const t of targets) expect(ORDER).toContain(t);
    for (const targets of Object.values(PAYMENT_TRANSITIONS)) for (const t of targets) expect(PAY).toContain(t);
  });
});

describe("full order transition matrix", () => {
  for (const from of ORDER) {
    for (const to of ORDER) {
      const allowed = EXPECTED_ORDER[from].includes(to);
      it(`${from} → ${to} is ${allowed ? "allowed" : "rejected"}`, () => {
        expect(canTransitionOrder(from, to)).toBe(allowed);
        // Use a system actor with a reason so only the graph can reject.
        const r = validateTransition({ from, to, actor: SYSTEM, reason: "test", ...(to === "paid" && from !== to ? { payment: { from: "unpaid" as const, to: "paid" as const } } : {}) });
        if (from === to) expect(r?.code).toBe("invalid_transition");
        else if (!allowed) expect(r?.code).toBe("invalid_transition");
        else expect(r).toBeNull();
      });
    }
  }
  it("terminal states have no exits", () => {
    expect(ORDER_TRANSITIONS.delivered).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe("full payment transition matrix", () => {
  for (const from of PAY) {
    for (const to of PAY) {
      const allowed = EXPECTED_PAYMENT[from].includes(to);
      it(`payment ${from} → ${to} is ${allowed ? "allowed" : "rejected"}`, () => {
        expect(canTransitionPayment(from, to)).toBe(allowed);
        const r = validateTransition({ from: "dispatched", to: "dispatched", payment: { from, to }, actor: GATEWAY, reason: "test" });
        expect(r === null).toBe(allowed);
        if (!allowed) expect(r?.code).toBe("invalid_transition");
      });
    }
  }
});

describe("actor and reason rules", () => {
  const ok = (over: object) => validateTransition({ from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY, ...over });

  it("only gateway/system may mark an order paid or a payment paid (no manual or automatic offline confirmation)", () => {
    expect(ok({})).toBeNull();
    expect(ok({ actor: SYSTEM })).toBeNull();
    for (const type of ["admin", "customer"] as OrderActorType[]) {
      expect(ok({ actor: { type }, reason: "x" })?.code).toBe("actor_not_allowed");
    }
    const pay = (type: OrderActorType) => validateTransition({ from: "confirmed", to: "confirmed", payment: { from: "unpaid", to: "paid" }, actor: { type }, reason: "x" });
    expect(pay("admin")?.code).toBe("actor_not_allowed");
    expect(pay("customer")?.code).toBe("actor_not_allowed");
    expect(pay("gateway")).toBeNull();
  });

  it("customers cannot confirm, dispatch or deliver", () => {
    for (const [from, to] of [["pending_confirmation", "confirmed"], ["confirmed", "dispatched"], ["dispatched", "delivered"]] as const) {
      expect(validateTransition({ from, to, actor: { type: "customer" } })?.code).toBe("actor_not_allowed");
    }
    expect(validateTransition({ from: "pending_confirmation", to: "cancelled", actor: { type: "customer" }, reason: "changed my mind" })).toBeNull();
  });

  it("requires a reason for admin actors, cancellations and refunds", () => {
    expect(validateTransition({ from: "pending_confirmation", to: "confirmed", actor: ADMIN })?.code).toBe("reason_required");
    expect(validateTransition({ from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "   " })?.code).toBe("reason_required");
    expect(validateTransition({ from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "called customer" })).toBeNull();
    expect(validateTransition({ from: "paid", to: "cancelled", actor: SYSTEM })?.code).toBe("reason_required");
    expect(validateTransition({ from: "paid", to: "paid", payment: { from: "paid", to: "refunded" }, actor: SYSTEM })?.code).toBe("reason_required");
    expect(validateTransition({ from: "pending_confirmation", to: "cancelled", actor: SYSTEM, reason: "x".repeat(501) })?.code).toBe("invalid_reason");
  });

  it("enforces combined order/payment invariants", () => {
    expect(validateTransition({ from: "awaiting_payment", to: "paid", actor: GATEWAY })?.code).toBe("invalid_transition");
    expect(validateTransition({ from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "failed" }, actor: GATEWAY })?.code).toBe("invalid_transition");
    expect(validateTransition({ from: "awaiting_payment", to: "cancelled", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY, reason: "x" })?.code).toBe("invalid_transition");
    expect(validateTransition({ from: "cancelled", to: "cancelled", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY, reason: "x" })?.code).toBe("invalid_transition");
    expect(validateTransition({ from: "awaiting_payment", to: "cancelled", payment: { from: "unpaid", to: "failed" }, actor: SYSTEM, reason: "gateway rejected" })).toBeNull();
  });

  it("rejects a no-op", () => {
    expect(validateTransition({ from: "paid", to: "paid", actor: SYSTEM })?.code).toBe("invalid_transition");
  });
});

describe("transitionOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.orderEvent.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "ev1", createdAt: new Date(), ...data }));
  });

  it("applies a conditional update and records the event inside one transaction", async () => {
    const r = await transitionOrder({ orderId: "o1", from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY, data: { razorpayPaymentId: "pay_1" } });
    expect(r.ok).toBe(true);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: "awaiting_payment", paymentStatus: "unpaid" },
      data: { status: "paid", paymentStatus: "paid", razorpayPaymentId: "pay_1" },
    });
    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: { orderId: "o1", fromStatus: "awaiting_payment", toStatus: "paid", fromPaymentStatus: "unpaid", toPaymentStatus: "paid", actorType: "gateway", actorId: null, reason: null },
    });
    // nothing is written outside the transaction
    expect(dbMock.order.updateMany).not.toHaveBeenCalled();
    expect(dbMock.order.update).not.toHaveBeenCalled();
    expect(dbMock.orderEvent.create).not.toHaveBeenCalled();
  });

  it("does not touch paymentStatus for an order-only change and trims the reason", async () => {
    await transitionOrder({ orderId: "o1", from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "  called  " });
    expect(tx.order.updateMany).toHaveBeenCalledWith({ where: { id: "o1", status: "pending_confirmation" }, data: { status: "confirmed" } });
    expect(tx.orderEvent.create.mock.calls[0][0].data).toMatchObject({ fromPaymentStatus: null, toPaymentStatus: null, reason: "called", actorId: "admin" });
  });

  it("joins a caller-supplied transaction instead of opening its own", async () => {
    const r = await transitionOrder({ orderId: "o1", from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY }, tx as never);
    expect(r.ok).toBe(true);
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderEvent.create).toHaveBeenCalledTimes(1);
  });

  it("invalid requests never open a transaction", async () => {
    const r = await transitionOrder({ orderId: "o1", from: "delivered", to: "pending_confirmation", actor: SYSTEM });
    expect(r).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns stale_state with the current statuses and writes no event when the order moved", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue({ status: "cancelled", paymentStatus: "unpaid" });
    const r = await transitionOrder({ orderId: "o1", from: "awaiting_payment", to: "paid", payment: { from: "unpaid", to: "paid" }, actor: GATEWAY });
    expect(r).toMatchObject({ ok: false, code: "stale_state", current: { status: "cancelled", paymentStatus: "unpaid" } });
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("returns not_found for an unknown order", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue(null);
    expect(await transitionOrder({ orderId: "nope", from: "confirmed", to: "dispatched", actor: SYSTEM })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("propagates database failures so the transaction rolls back", async () => {
    tx.orderEvent.create.mockRejectedValue(new Error("db down"));
    await expect(transitionOrder({ orderId: "o1", from: "confirmed", to: "dispatched", actor: SYSTEM })).rejects.toThrow("db down");
  });
});
