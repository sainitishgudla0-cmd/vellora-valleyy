/**
 * M11 P1-T2 (F04): recording money that moved outside any gateway is a dedicated, attested, immutable operation.
 * Owner only (`payments:record`) until the business decides otherwise; full amount and method required; one reference
 * per collection even under concurrency; the record cannot be rewritten; offline refunds of gateway payments refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanupAdminFixtures, createLegacySession, createTestAdmin } from "../support/admin";
import { cleanupFixtures, createFixtureOrder, createRazorpayOrderWithAttempt } from "../support/mock-orders";
import { PATCH } from "@/app/api/admin/orders/[id]/route";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
let owner: Admin, operations: Admin, catalog: Admin, viewer: Admin;
const tag = Date.now().toString(36);
let seq = 0;
const ref = () => `RCPT-P1T2-${tag}-${++seq}`;

const patch = async (cookie: string, id: string, body: unknown) => {
  const res = await PATCH(new Request("http://localhost/api/admin/orders/x", { method: "PATCH", headers: { cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
async function codOrder(paymentStatus: "unpaid" | "paid" = "unpaid", total = 64000) {
  const order = await createFixtureOrder({ paymentMethod: "cod", paymentMode: "request_only", status: "confirmed", paymentStatus, total });
  await db.payment.create({ data: { orderId: order.id, provider: "request_only", mode: "request_only", amount: total, currency: "INR", status: paymentStatus } });
  return order;
}
const load = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: true, events: true } });
const collect = (amountPaise = 64000, method = "upi") => ({ paymentStatus: "paid", reason: "Collected by the delivery partner", paymentReference: ref(), offline: { amountPaise, method } });

beforeAll(async () => {
  owner = await createTestAdmin("owner");
  operations = await createTestAdmin("operations");
  catalog = await createTestAdmin("catalog");
  viewer = await createTestAdmin("viewer");
});
afterAll(async () => {
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("who may record an offline collection", () => {
  it("only an owner account; operations, catalog, viewer and the shared password are refused and nothing changes", async () => {
    const o = await codOrder();
    const legacy = await createLegacySession();
    for (const c of [operations.cookie, catalog.cookie, viewer.cookie, legacy.cookie]) expect((await patch(c, o.id, collect())).status).toBe(403);
    const after = await load(o.id);
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.payments[0]).toMatchObject({ status: "unpaid", manualReference: null, manualMethod: null });
    expect(after.events).toHaveLength(0);
    const denied = await db.auditLog.findMany({ where: { targetId: o.id, action: "access.denied" } });
    expect(denied.map((d) => JSON.parse(d.details!).permission)).toContain("payments:record");
    // operations can still run the order itself
    expect((await patch(operations.cookie, o.id, { status: "cancelled", reason: "customer asked" })).status).toBe(200);
  });

  it("an owner records it with the attested amount, method, recorder and time, in one audited transaction", async () => {
    const o = await codOrder();
    const body = collect(64000, "bank_transfer");
    expect((await patch(owner.cookie, o.id, body)).status).toBe(200);
    const after = await load(o.id);
    expect(after.paymentStatus).toBe("paid");
    expect(after.payments[0]).toMatchObject({ status: "paid", manualReference: body.paymentReference, manualMethod: "bank_transfer", manualRecordedBy: owner.user.id });
    expect(after.payments[0].manualRecordedAt).toBeInstanceOf(Date);
    expect(after.events[0]).toMatchObject({ toPaymentStatus: "paid", paymentReference: body.paymentReference, actorId: owner.user.id });
    const audit = await db.auditLog.findFirstOrThrow({ where: { targetId: o.id, action: "order.update", outcome: "success" } });
    expect(JSON.parse(audit.details!)).toMatchObject({ offlineMethod: "bank_transfer", amountPaise: 64000 });
  });
});

describe("attestation", () => {
  it("needs the amount and method; partial or excess amounts and unknown methods are refused without changes", async () => {
    const o = await codOrder();
    const { offline: _offline, ...withoutOffline } = collect();
    void _offline;
    expect(await patch(owner.cookie, o.id, withoutOffline)).toMatchObject({ status: 422, body: { fields: { offline: expect.stringMatching(/amount and how/) } } });
    expect((await patch(owner.cookie, o.id, collect(63999))).status).toBe(422);
    expect((await patch(owner.cookie, o.id, collect(64001))).status).toBe(422);
    expect((await patch(owner.cookie, o.id, collect(64000, "crypto"))).status).toBe(422);
    expect((await load(o.id)).paymentStatus).toBe("unpaid");
  });
});

describe("integrity", () => {
  it("one external reference cannot record two collections, even when both requests race", async () => {
    const [a, b] = [await codOrder(), await codOrder()];
    const reference = ref();
    const body = { ...collect(), paymentReference: reference };
    const results = await Promise.all([patch(owner.cookie, a.id, body), patch(owner.cookie, b.id, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("reference_in_use");
    const states = await Promise.all([load(a.id), load(b.id)]);
    expect(states.filter((s) => s.paymentStatus === "paid")).toHaveLength(1);
    expect(states.filter((s) => s.paymentStatus === "unpaid")[0].events).toHaveLength(0);
  });

  it("a recorded collection cannot be rewritten or erased, even by a direct database update", async () => {
    const o = await codOrder();
    expect((await patch(owner.cookie, o.id, collect())).status).toBe(200);
    const p = (await load(o.id)).payments[0];
    for (const data of [{ manualReference: "RCPT-REWRITTEN" }, { manualReference: null }, { manualMethod: "cash" }, { manualRecordedBy: "someone-else" }, { manualRecordedAt: new Date(0) }]) {
      await expect(db.payment.update({ where: { id: p.id }, data })).rejects.toThrow(/cannot be changed/);
    }
    // the rest of the row still works (e.g. a later refund bookkeeping status change)
    await expect(db.payment.update({ where: { id: p.id }, data: { lastCheckedAt: new Date() } })).resolves.toBeTruthy();
  });

  it("the database refuses offline fields on a gateway payment or without a reference", async () => {
    const rz = await createRazorpayOrderWithAttempt({ status: "paid", paymentStatus: "paid" });
    await expect(db.payment.update({ where: { id: rz.attempt.id }, data: { manualMethod: "cash" } })).rejects.toThrow();
    const o = await codOrder();
    const p = (await load(o.id)).payments[0];
    await expect(db.payment.update({ where: { id: p.id }, data: { manualMethod: "cash" } })).rejects.toThrow(); // method without reference
  });
});

describe("offline refunds", () => {
  it("returning a pay-on-delivery payment outside any gateway needs the owner and the full amount", async () => {
    const o = await codOrder("paid");
    const body = { paymentStatus: "refunded", reason: "Returned in cash at the door", offline: { amountPaise: 64000, method: "cash" } };
    expect((await patch(operations.cookie, o.id, body)).status).toBe(403);
    expect((await patch(owner.cookie, o.id, { ...body, offline: { amountPaise: 30000, method: "cash" } })).status).toBe(422);
    expect((await patch(owner.cookie, o.id, body)).status).toBe(200);
    expect(await load(o.id)).toMatchObject({ paymentStatus: "refunded" });
  });

  it("are never possible for a gateway payment, whoever asks and whatever they attest (policy-dependent: disabled)", async () => {
    const rz = await createRazorpayOrderWithAttempt({ status: "paid", paymentStatus: "paid", total: 64000 });
    const r = await patch(owner.cookie, rz.order.id, { paymentStatus: "refunded", reason: "Refunded in cash", offline: { amountPaise: 64000, method: "cash" } });
    expect(r).toMatchObject({ status: 409, body: { code: "payment_edit_not_allowed" } });
    expect(await load(rz.order.id)).toMatchObject({ paymentStatus: "paid" });
  });
});
