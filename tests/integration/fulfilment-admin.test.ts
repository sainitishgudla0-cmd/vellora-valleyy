/** M7: admin endpoints for tax rates, shipping rules, shipments and the outbox; the public shipping quote; customer tracking view. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@prisma/client";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { transitionOrder } from "@/lib/orders/state-machine";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv, signInCustomer } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupFulfilmentFixtures, fulfilmentEnv, placeCod, SHIP_TO_AP } from "../support/fulfilment";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { GET as ratesGet, POST as ratesPost } from "@/app/api/admin/tax-rates/route";
import { GET as rulesGet, POST as rulesPost } from "@/app/api/admin/shipping-rules/route";
import { PATCH as rulePatch, DELETE as ruleDelete } from "@/app/api/admin/shipping-rules/[id]/route";
import { GET as shipmentsGet, POST as shipmentsPost } from "@/app/api/admin/orders/[id]/shipments/route";
import { PATCH as shipmentPatch } from "@/app/api/admin/shipments/[id]/route";
import { GET as outboxGet } from "@/app/api/admin/outbox/route";
import { POST as outboxRetry } from "@/app/api/admin/outbox/[id]/retry/route";
import { POST as invoicePost } from "@/app/api/admin/orders/[id]/invoice/route";
import { GET as invoicesGet } from "@/app/api/admin/invoices/route";
import { GET as invoiceGet } from "@/app/api/admin/invoices/[id]/route";
import { GET as shippingQuote } from "@/app/api/shipping/quote/route";
import { GET as accountOrder } from "@/app/api/account/orders/[number]/route";
import { POST as retailOrder } from "@/app/api/orders/route";

const mk = (url: string, method: string, cookie?: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const ADMIN = { type: "admin" as const, id: "t" };

let owner: Awaited<ReturnType<typeof createTestAdmin>>;
let variantId: string;
beforeEach(async () => {
  fulfilmentEnv();
  customerTestEnv();
  rate.rateLimit.mockResolvedValue(true);
  owner ??= await createTestAdmin("owner");
  variantId ??= (await createInventoryVariant({ tracked: false, price: 10500 })).variantId;
  await db.shippingRule.deleteMany({});
  await db.taxRate.deleteMany({});
  await db.auditLog.deleteMany({});
});
afterAll(async () => {
  await cleanupFulfilmentFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("role × route matrix", () => {
  const ROLES: AdminRole[] = ["owner", "operations", "catalog", "viewer"];
  const FUL: AdminRole[] = ["owner", "operations"];
  const ROUTES: [string, AdminRole[], (c?: string) => Promise<Response>][] = [
    ["GET tax-rates", FUL, (c) => ratesGet(mk("/api/admin/tax-rates", "GET", c))],
    ["POST tax-rates", ["owner"], (c) => ratesPost(mk("/api/admin/tax-rates", "POST", c, { code: "0802", rateBp: 500, effectiveFrom: `20${Math.floor(Math.random() * 40) + 40}-01-01` }))],
    ["GET shipping-rules", FUL, (c) => rulesGet(mk("/api/admin/shipping-rules", "GET", c))],
    ["POST shipping-rules", FUL, (c) => rulesPost(mk("/api/admin/shipping-rules", "POST", c, { name: "Matrix", pincodePrefix: String(Math.floor(Math.random() * 900000) + 100000) }))],
    ["PATCH shipping-rules/[id]", FUL, (c) => rulePatch(mk("/api/admin/shipping-rules/x", "PATCH", c, { active: true }), ctx({ id: "x" }))],
    ["DELETE shipping-rules/[id]", FUL, (c) => ruleDelete(mk("/api/admin/shipping-rules/x", "DELETE", c), ctx({ id: "x" }))],
    ["GET orders/[id]/shipments", FUL, (c) => shipmentsGet(mk("/api/admin/orders/x/shipments", "GET", c), ctx({ id: "x" }))],
    ["POST orders/[id]/shipments", FUL, (c) => shipmentsPost(mk("/api/admin/orders/x/shipments", "POST", c, { courier: "Delhivery", awb: "DL123456" }), ctx({ id: "x" }))],
    ["PATCH shipments/[id]", FUL, (c) => shipmentPatch(mk("/api/admin/shipments/x", "PATCH", c, { status: "in_transit" }), ctx({ id: "x" }))],
    ["GET outbox", FUL, (c) => outboxGet(mk("/api/admin/outbox", "GET", c))],
    ["POST outbox/[id]/retry", FUL, (c) => outboxRetry(mk("/api/admin/outbox/x/retry", "POST", c), ctx({ id: "x" }))],
    ["POST orders/[id]/invoice", FUL, (c) => invoicePost(mk("/api/admin/orders/x/invoice", "POST", c), ctx({ id: "x" }))],
    ["GET invoices", FUL, (c) => invoicesGet(mk("/api/admin/invoices", "GET", c))],
    ["GET invoices/[id]", FUL, (c) => invoiceGet(mk("/api/admin/invoices/x", "GET", c), ctx({ id: "x" }))],
  ];
  it.each(ROUTES)("%s", async (_n, allowed, call) => {
    expect((await call()).status).toBe(401);
    for (const role of ROLES) {
      const who = role === "owner" ? owner : await createTestAdmin(role);
      const status = (await call(who.cookie)).status;
      if (allowed.includes(role)) expect([401, 403], `${role} should be allowed`).not.toContain(status);
      else expect(status, `${role} should be refused`).toBe(403);
    }
  });
});

describe("tax rates API", () => {
  it("adds rates (owner only), append-only per code and date, validated, audited; lists newest first", async () => {
    const post = (b: unknown) => ratesPost(mk("/api/admin/tax-rates", "POST", owner.cookie, b)).then(read);
    expect(await post({ code: "08041020", rateBp: 500, effectiveFrom: "2026-04-01", note: "per accountant, ref 12" })).toMatchObject({ status: 201, body: { rate: { code: "08041020", rateBp: 500, effectiveFrom: "2026-04-01" } } });
    expect(await post({ code: "08041020", rateBp: 1200, effectiveFrom: "2026-10-01" })).toMatchObject({ status: 201 });
    expect(await post({ code: "08041020", rateBp: 700, effectiveFrom: "2026-04-01" })).toMatchObject({ status: 409, body: { code: "rate_exists" } });
    for (const bad of [{ code: "12", rateBp: 500, effectiveFrom: "2026-04-01" }, { code: "0804", rateBp: 6000, effectiveFrom: "2026-04-01" }, { code: "0804", rateBp: 500, effectiveFrom: "tomorrow" }, { code: "0804", rateBp: 500, effectiveFrom: "2026-04-01", extra: true }]) expect((await post(bad)).status).toBe(422);
    const list = await read(await ratesGet(mk("/api/admin/tax-rates", "GET", owner.cookie)));
    expect(list.body.rates.map((r: any) => [r.code, r.rateBp, r.effectiveFrom])).toEqual([["08041020", 1200, "2026-10-01"], ["08041020", 500, "2026-04-01"]]);
    const rows = await db.auditLog.findMany({ where: { action: "tax_rate.create" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.outcome)).toEqual(["success", "success", "rejected"]);
    expect(JSON.stringify(rows)).not.toContain("accountant"); // free-text notes are not copied into the log
  });
});

describe("shipping rules API and the public quote", () => {
  const post = (b: unknown, cookie = owner.cookie) => rulesPost(mk("/api/admin/shipping-rules", "POST", cookie, b)).then(read);
  const quote = (qs: string) => shippingQuote(mk(`/api/shipping/quote${qs}`, "GET")).then(read);

  it("CRUD with validation, one rule per prefix, audited; the list reports legacy mode", async () => {
    expect((await read(await rulesGet(mk("/api/admin/shipping-rules", "GET", owner.cookie)))).body).toMatchObject({ rules: [], legacyMode: true });
    const created = await post({ name: "Anantapur", pincodePrefix: "515", fee: 2500, freeAboveSubtotal: 100000 });
    expect(created).toMatchObject({ status: 201, body: { rule: { pincodePrefix: "515", fee: 2500, freeAboveSubtotal: 100000, serviceable: true, active: true } } });
    expect(await post({ name: "Dup", pincodePrefix: "515" })).toMatchObject({ status: 409, body: { code: "prefix_in_use" } });
    for (const bad of [{ name: "x", pincodePrefix: "5" }, { name: "Bad", pincodePrefix: "5x" }, { name: "Neg", pincodePrefix: "6", fee: -1 }, { name: "Extra", pincodePrefix: "7", isAdmin: true }]) expect((await post(bad)).status).toBe(422);
    const id = created.body.rule.id;
    expect((await read(await rulePatch(mk(`/api/admin/shipping-rules/${id}`, "PATCH", owner.cookie, { fee: 3000, active: false }), ctx({ id })))).body.rule).toMatchObject({ fee: 3000, active: false });
    expect((await rulePatch(mk(`/api/admin/shipping-rules/${id}`, "PATCH", owner.cookie, {}), ctx({ id }))).status).toBe(422);
    // regression: a partial update must not reset the fields it does not mention (create-time defaults must not leak into PATCH)
    await rulePatch(mk(`/api/admin/shipping-rules/${id}`, "PATCH", owner.cookie, { name: "Anantapur city" }), ctx({ id }));
    expect(await db.shippingRule.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Anantapur city", fee: 3000, active: false, serviceable: true, freeAboveSubtotal: 100000 });
    expect((await rulePatch(mk("/api/admin/shipping-rules/none", "PATCH", owner.cookie, { fee: 1 }), ctx({ id: "none" }))).status).toBe(404);
    const other = (await post({ name: "Other", pincodePrefix: "516" })).body.rule.id;
    expect((await rulePatch(mk(`/api/admin/shipping-rules/${other}`, "PATCH", owner.cookie, { pincodePrefix: "515" }), ctx({ id: other }))).status).toBe(409);
    expect((await ruleDelete(mk(`/api/admin/shipping-rules/${id}`, "DELETE", owner.cookie), ctx({ id }))).status).toBe(200);
    expect((await ruleDelete(mk(`/api/admin/shipping-rules/${id}`, "DELETE", owner.cookie), ctx({ id }))).status).toBe(404);
    expect((await db.auditLog.findMany({ where: { action: { startsWith: "shipping_rule." } } })).length).toBeGreaterThanOrEqual(6);
  });

  it("the public quote answers exactly what an order would be charged, and validates input", async () => {
    expect(await quote("?pincode=515001&subtotal=1000")).toMatchObject({ status: 200, body: { serviceable: true, fee: 0, freeAboveSubtotal: null, ruleBased: false } }); // legacy mode
    await post({ name: "All", pincodePrefix: "", fee: 9900 });
    await post({ name: "Anantapur", pincodePrefix: "515", fee: 2500, freeAboveSubtotal: 50000 });
    await post({ name: "Island", pincodePrefix: "682", serviceable: false });
    expect((await quote("?pincode=515001&subtotal=1000")).body).toEqual({ serviceable: true, fee: 2500, freeAboveSubtotal: 50000, ruleBased: true });
    expect((await quote("?pincode=515001&subtotal=50000")).body.fee).toBe(0);
    expect((await quote("?pincode=110001")).body).toEqual({ serviceable: true, fee: 9900, freeAboveSubtotal: null, ruleBased: true });
    expect((await quote("?pincode=682001")).body).toEqual({ serviceable: false, fee: 0, freeAboveSubtotal: null, ruleBased: true });
    for (const bad of ["", "?pincode=12345", "?pincode=012345", "?pincode=abcdef", "?pincode=515001&subtotal=-5", "?pincode=515001&subtotal=x"]) expect((await quote(bad)).status).toBe(422);
    rate.rateLimit.mockResolvedValue(false);
    expect((await quote("?pincode=515001")).status).toBe(429);
    rate.rateLimit.mockResolvedValue(true);
    // the quote and the order agree
    const o = await read(await retailOrder(mk("/api/orders", "POST", undefined, { ...SHIP_TO_AP, paymentMethod: "cod", items: [{ variantId, quantity: 1 }] })));
    expect((await db.order.findUniqueOrThrow({ where: { number: o.body.order.number } })).deliveryFee).toBe(2500);
    const blocked = await read(await retailOrder(mk("/api/orders", "POST", undefined, { ...SHIP_TO_AP, pincode: "682001", paymentMethod: "cod", items: [{ variantId, quantity: 1 }] })));
    expect(blocked).toMatchObject({ status: 422, body: { error: "Sorry, we do not deliver to this pincode yet." } });
  });
});

describe("shipments", () => {
  const confirmed = async () => {
    const o = await placeCod(variantId);
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "ok" });
    return o;
  };
  const create = (id: string, b: unknown, cookie = owner.cookie) => shipmentsPost(mk(`/api/admin/orders/${id}/shipments`, "POST", cookie, b), ctx({ id })).then(read);
  const patch = (id: string, b: unknown) => shipmentPatch(mk(`/api/admin/shipments/${id}`, "PATCH", owner.cookie, b), ctx({ id })).then(read);
  const awb = () => `DL${Date.now()}${Math.floor(Math.random() * 1000)}`;

  it("records a shipment with tracking history for a confirmed order, without touching the order's status", async () => {
    const o = await confirmed();
    const r = await create(o.id, { courier: "Delhivery", awb: awb(), trackingUrl: "https://track.example.com/abc" });
    expect(r.status).toBe(201);
    const list = await read(await shipmentsGet(mk(`/api/admin/orders/${o.id}/shipments`, "GET", owner.cookie), ctx({ id: o.id })));
    expect(list.body.shipments[0]).toMatchObject({ courier: "Delhivery", status: "created", trackingUrl: "https://track.example.com/abc", events: [{ status: "created" }] });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("confirmed");
  });

  it("walks the tracking graph, refusing invalid moves and moves out of a terminal status", async () => {
    const o = await confirmed();
    const { shipmentId } = (await create(o.id, { courier: "Blue Dart", awb: awb() })).body;
    expect((await patch(shipmentId, { status: "delivered" })).status).toBe(409); // created -> delivered is not a step
    for (const status of ["picked_up", "in_transit", "out_for_delivery", "delivered"]) expect((await patch(shipmentId, { status, note: `at ${status}` })).status, status).toBe(200);
    expect(await patch(shipmentId, { status: "in_transit" })).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    expect((await db.shipmentEvent.findMany({ where: { shipmentId }, orderBy: { createdAt: "asc" } })).map((e) => e.status)).toEqual(["created", "picked_up", "in_transit", "out_for_delivery", "delivered"]);
    expect((await patch("none", { status: "in_transit" })).status).toBe(404);
    expect((await patch(shipmentId, { status: "bogus" })).status).toBe(422);
    expect((await db.auditLog.findMany({ where: { action: "shipment.update" } })).length).toBeGreaterThanOrEqual(6);
  });

  it("racing status changes: one wins, the other is refused (stale or invalid)", async () => {
    const o = await confirmed();
    const { shipmentId } = (await create(o.id, { courier: "DTDC", awb: awb() })).body;
    const results = await Promise.all([patch(shipmentId, { status: "picked_up" }), patch(shipmentId, { status: "in_transit" }), patch(shipmentId, { status: "failed" })]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const events = await db.shipmentEvent.count({ where: { shipmentId } });
    expect(events).toBe(1 + results.filter((r) => r.status === 200).length); // exactly one event per successful move
  });

  it("only for confirmed, paid or dispatched orders; AWB unique per courier; validated", async () => {
    const pending = await placeCod(variantId);
    expect(await create(pending.id, { courier: "Delhivery", awb: awb() })).toMatchObject({ status: 409, body: { code: "order_not_shippable" } });
    const o = await confirmed();
    const same = awb();
    expect((await create(o.id, { courier: "Delhivery", awb: same })).status).toBe(201);
    expect(await create(o.id, { courier: "Delhivery", awb: same })).toMatchObject({ status: 409, body: { code: "awb_in_use" } });
    expect((await create(o.id, { courier: "DTDC", awb: same })).status).toBe(201); // same number, different courier
    expect((await create("none", { courier: "Delhivery", awb: awb() })).status).toBe(404);
    for (const bad of [{ courier: "D", awb: awb() }, { courier: "Delhivery", awb: "x" }, { courier: "Delhivery", awb: "bad awb!" }, { courier: "Delhivery", awb: awb(), trackingUrl: "http://insecure.example" }, { courier: "Delhivery", awb: awb(), extra: 1 }]) expect((await create(o.id, bad)).status).toBe(422);
    const cancelled = await placeCod(variantId);
    await transitionOrder({ orderId: cancelled.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN, reason: "x" });
    expect((await create(cancelled.id, { courier: "Delhivery", awb: awb() })).status).toBe(409);
  });

  it("the customer sees their own shipment and tracking history, but never the staff's notes", async () => {
    const c = await signInCustomer();
    const o = await createOrder({ ...SHIP_TO_AP, paymentMethod: "cod", items: [{ variantId, quantity: 1 }] }, { customerId: c.customerId });
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: ADMIN, reason: "ok" });
    const { shipmentId } = (await create(o.id, { courier: "Delhivery", awb: awb(), trackingUrl: "https://track.example.com/z" })).body;
    await patch(shipmentId, { status: "picked_up", note: "INTERNAL-NOTE-do-not-show" });
    const r = await read(await accountOrder(mk(`/api/account/orders/${o.number}`, "GET", c.cookie), ctx({ number: o.number })));
    expect(r.body.order.shipments).toEqual([{ courier: "Delhivery", awb: expect.any(String), trackingUrl: "https://track.example.com/z", status: "picked_up", events: [{ status: "created", at: expect.any(String) }, { status: "picked_up", at: expect.any(String) }] }]);
    expect(JSON.stringify(r.body)).not.toContain("INTERNAL-NOTE");
    expect(r.body.order.invoice).toBeNull();
  });
});

describe("outbox admin", () => {
  it("lists the queue without recipients or content, and retries only failed or dead messages", async () => {
    const dead = await db.outboxMessage.create({ data: { template: "order_placed", subjectType: "order", subjectId: "o1", dedupeKey: `t-${Date.now()}-a`, status: "dead", attempts: 6, lastError: "provider_unavailable" } });
    const sent = await db.outboxMessage.create({ data: { template: "order_placed", subjectType: "order", subjectId: "o2", dedupeKey: `t-${Date.now()}-b`, status: "sent", attempts: 1, sentAt: new Date() } });
    const all = await read(await outboxGet(mk("/api/admin/outbox", "GET", owner.cookie)));
    expect(Object.keys(all.body.messages[0]).sort()).toEqual(["attempts", "createdAt", "id", "lastError", "nextAttemptAt", "sentAt", "status", "subjectId", "subjectType", "template"]);
    expect((await read(await outboxGet(mk("/api/admin/outbox?status=dead", "GET", owner.cookie)))).body.messages.map((m: any) => m.id)).toEqual([dead.id]);
    expect((await outboxGet(mk("/api/admin/outbox?status=nope", "GET", owner.cookie))).status).toBe(422);
    const retry = (id: string) => outboxRetry(mk(`/api/admin/outbox/${id}/retry`, "POST", owner.cookie), ctx({ id }));
    expect((await retry(sent.id)).status).toBe(404);
    expect((await retry(dead.id)).status).toBe(200);
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: dead.id } })).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  });
});
