/** M7-T2: invoices: issuing, gap-free numbering under concurrency and failure, frozen regeneration, access, cancellation guard. */
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { issueInvoice } from "@/lib/invoices/issue";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import { transitionOrder } from "@/lib/orders/state-machine";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupCustomerFixtures, customerTestEnv, signInCustomer } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupWholesaleFixtures, makeBuyer, SHIPPING } from "../support/wholesale";
import { cleanupFulfilmentFixtures, fulfilmentEnv, placeCod, setRate, SHIP_TO_KA } from "../support/fulfilment";
import { createOrder } from "@/lib/orders";
import type { InvoicePayload } from "@/lib/invoices/payload";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as issueRoute } from "@/app/api/admin/orders/[id]/invoice/route";
import { GET as invoiceGet } from "@/app/api/admin/invoices/[id]/route";
import { GET as invoiceList } from "@/app/api/admin/invoices/route";
import { GET as accountInvoice } from "@/app/api/account/orders/[number]/invoice/route";
import { PATCH as orderPatch } from "@/app/api/admin/orders/[id]/route";

const ADMIN_TRANSITION = { type: "admin" as const, id: "t" };
const mk = (url: string, method: string, cookie?: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const confirm = (id: string) => transitionOrder({ orderId: id, from: "pending_confirmation", to: "confirmed", actor: ADMIN_TRANSITION, reason: "ok" });

let admin: Awaited<ReturnType<typeof createTestAdmin>>;
let variantId: string;
beforeEach(async () => {
  fulfilmentEnv();
  customerTestEnv();
  vi.stubEnv("SELLER_GSTIN", (await import("../support/fulfilment")).SELLER_GSTIN);
  rate.rateLimit.mockResolvedValue(true);
  admin ??= await createTestAdmin("owner");
  variantId ??= (await createInventoryVariant({ tracked: false, price: 10500 })).variantId;
  await db.invoice.deleteMany({});
  await db.invoiceSeries.deleteMany({});
  await db.taxRate.deleteMany({});
  await db.shippingRule.deleteMany({});
  await setRate("0802", 500);
});
afterAll(async () => {
  await cleanupFulfilmentFixtures();
  await cleanupWholesaleFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

async function confirmedOrder(over: Parameters<typeof placeCod>[1] = {}) {
  const o = await placeCod(variantId, over);
  expect((await confirm(o.id)).ok).toBe(true);
  return o;
}

describe("issuing", () => {
  it("issues a tax invoice for a confirmed order: frozen payload, exact totals, intra-state split", async () => {
    const o = await confirmedOrder({ quantity: 3 });
    const r = await issueInvoice(o.id, new Date("2026-11-12T10:00:00Z"));
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    expect(r.invoice).toMatchObject({ number: "VV/26-27/000001", financialYear: "2026-27", seq: 1, supplyType: "intra", taxableTotal: 30000, cgstTotal: 750, sgstTotal: 750, igstTotal: 0, total: 31500, buyerGstin: null });
    const p = JSON.parse(r.invoice.payload) as InvoicePayload;
    expect(p).toMatchObject({ number: "VV/26-27/000001", order: { number: o.number }, placeOfSupply: { state: "Andhra Pradesh", stateCode: "37" }, seller: { stateCode: "37" }, reverseCharge: false });
    expect(p.lines).toEqual([expect.objectContaining({ hsCode: "0802", quantity: 3, unitPrice: 10500, rateBp: 500, taxableValue: 30000, cgst: 750, sgst: 750, total: 31500 })]);
    expect(p.totals.total).toBe(o.total);
  });

  it("is idempotent: one invoice per order, a repeat returns it unchanged", async () => {
    const o = await confirmedOrder();
    const a = await issueInvoice(o.id);
    const b = await issueInvoice(o.id);
    expect(a.ok && b.ok && a.invoice.id === b.invoice.id && !b.created).toBe(true);
    expect(await db.invoice.count({ where: { orderId: o.id } })).toBe(1);
    expect((await db.invoiceSeries.findMany()).map((s) => s.lastSeq)).toEqual([1]); // the repeat did not consume a number
  });

  it("uses IGST for an inter-state order and carries the business buyer's GSTIN and company", async () => {
    const buyer = await makeBuyer();
    const o = await createOrder({ ...SHIPPING, state: "Karnataka", pincode: "560001", city: "Bengaluru", paymentMethod: "cod", items: [{ variantId, quantity: 4 }] }, { customerId: buyer.customerId, wholesale: { businessAccountId: buyer.account.id, priceLines: async (_t, lines) => new Map(lines.map((l) => [l.variant.id, 9000])) } });
    await confirm(o.id);
    const r = await issueInvoice(o.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invoice).toMatchObject({ supplyType: "inter", cgstTotal: 0, sgstTotal: 0, buyerGstin: buyer.account.gstin });
    expect(r.invoice.igstTotal).toBe(1714);
    expect(JSON.parse(r.invoice.payload).buyer).toMatchObject({ company: "Rao Traders", gstin: buyer.account.gstin, state: "Karnataka", stateCode: "29" });
  });

  it("includes the delivery charge (taxed) so the invoice total equals the order total", async () => {
    await setRate("DELIVERY", 1800);
    await db.shippingRule.create({ data: { name: "All", pincodePrefix: "", fee: 5900 } });
    const o = await confirmedOrder({ quantity: 2 });
    const r = await issueInvoice(o.id);
    if (!r.ok) throw new Error(r.message);
    expect(r.invoice.total).toBe(o.total);
    expect(JSON.parse(r.invoice.payload).delivery).toMatchObject({ rateBp: 1800, taxableValue: 5000, cgst: 450, sgst: 450, total: 5900 });
  });

  it("computes missing line tax from the rates in force on the ORDER's date (order placed before any rate existed)", async () => {
    await db.taxRate.deleteMany({});
    const o = await confirmedOrder({ quantity: 2 });
    expect((await db.orderItem.findFirstOrThrow({ where: { orderId: o.id } })).gstRateBp).toBeNull();
    await setRate("0802", 1800, "2099-01-01"); // a future rate must not be used
    expect(await issueInvoice(o.id)).toMatchObject({ ok: false, code: "tax_not_configured", detail: ["0802"] });
    await setRate("0802", 1200, "2020-01-01");
    await setRate("0802", 500, "2099-06-01");
    const r = await issueInvoice(o.id);
    if (!r.ok) throw new Error(r.message);
    expect(JSON.parse(r.invoice.payload).lines[0]).toMatchObject({ rateBp: 1200 });
  });

  it("refuses with a clear reason instead of guessing: seller not configured, rate missing, order not invoiceable, unknown order", async () => {
    await db.taxRate.deleteMany({});
    const o = await confirmedOrder(); // placed while no rate was configured: no snapshot on its line
    expect(await issueInvoice(o.id)).toMatchObject({ ok: false, code: "tax_not_configured" });
    await setRate("0802", 500);
    vi.stubEnv("SELLER_GSTIN", "");
    expect(await issueInvoice(o.id)).toMatchObject({ ok: false, code: "seller_not_configured" });
    vi.stubEnv("SELLER_GSTIN", "37AAAAA0000A1ZX");
    expect(await issueInvoice(o.id)).toMatchObject({ ok: false, code: "seller_not_configured" });
    vi.stubEnv("SELLER_GSTIN", (await import("../support/fulfilment")).SELLER_GSTIN);
    const pending = await placeCod(variantId);
    expect(await issueInvoice(pending.id)).toMatchObject({ ok: false, code: "order_not_invoiceable" });
    expect(await issueInvoice("missing")).toMatchObject({ ok: false, code: "not_found" });
    expect(await db.invoice.count()).toBe(0);
    expect(await db.invoiceSeries.count()).toBe(0); // no number was consumed by any refusal
  });

  it("an order pre-dating M7 (no HSN on the line) is invoiced with the variant's HSN", async () => {
    const o = await confirmedOrder();
    await db.orderItem.updateMany({ where: { orderId: o.id }, data: { hsCode: null } });
    const r = await issueInvoice(o.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.invoice.payload).lines[0].hsCode).toBe("0802");
  });
});

describe("numbering (gap-free, per financial year)", () => {
  it("20 parallel invoices for 20 orders get exactly 1..20, no duplicates, no gaps", async () => {
    const orders = [];
    for (let i = 0; i < 20; i++) orders.push(await confirmedOrder());
    const results = await Promise.all(orders.map((o) => issueInvoice(o.id, new Date("2026-11-12T10:00:00Z"))));
    expect(results.every((r) => r.ok && r.created)).toBe(true);
    const seqs = (await db.invoice.findMany({ select: { seq: true, number: true } })).sort((a, b) => a.seq - b.seq);
    expect(seqs.map((s) => s.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(seqs.map((s) => s.number)).size).toBe(20);
    expect((await db.invoiceSeries.findUniqueOrThrow({ where: { financialYear: "2026-27" } })).lastSeq).toBe(20);
  }, 60_000);

  it("parallel requests for the SAME order create one invoice and consume one number", async () => {
    const o = await confirmedOrder();
    const results = await Promise.all(Array.from({ length: 8 }, () => issueInvoice(o.id)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.invoice.id : ""))).size).toBe(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect((await db.invoiceSeries.findUniqueOrThrow({ where: { financialYear: "2026-27" } })).lastSeq).toBe(1);
  });

  it("a failure after the number was taken rolls the number back: the next invoice gets it (no gap)", async () => {
    const [a, b, c] = [await confirmedOrder(), await confirmedOrder(), await confirmedOrder()];
    expect((await issueInvoice(a.id)).ok).toBe(true); // 1
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION m7_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER m7_fail BEFORE INSERT ON "Invoice" FOR EACH ROW EXECUTE FUNCTION m7_fail()`);
    try {
      await expect(issueInvoice(b.id)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER m7_fail ON "Invoice"`);
      await db.$executeRawUnsafe(`DROP FUNCTION m7_fail()`);
    }
    expect((await db.invoiceSeries.findUniqueOrThrow({ where: { financialYear: "2026-27" } })).lastSeq).toBe(1);
    expect((await issueInvoice(b.id)) && (await db.invoice.findUniqueOrThrow({ where: { orderId: b.id } })).seq).toBe(2);
    expect((await issueInvoice(c.id)) && (await db.invoice.findUniqueOrThrow({ where: { orderId: c.id } })).seq).toBe(3);
  });

  it("each financial year has its own series starting at 1", async () => {
    const [a, b, c] = [await confirmedOrder(), await confirmedOrder(), await confirmedOrder()];
    const x = await issueInvoice(a.id, new Date("2027-03-31T10:00:00Z")); // FY 2026-27
    const y = await issueInvoice(b.id, new Date("2027-03-31T19:00:00Z")); // 00:30 IST on 1 April: FY 2027-28
    const z = await issueInvoice(c.id, new Date("2027-04-02T10:00:00Z"));
    expect([x, y, z].map((r) => (r.ok ? r.invoice.number : r.message))).toEqual(["VV/26-27/000001", "VV/27-28/000001", "VV/27-28/000002"]);
  });

  it("the database refuses a bad invoice (duplicate number, mismatched totals, over-long number)", async () => {
    const o = await confirmedOrder();
    const r = await issueInvoice(o.id);
    if (!r.ok) throw new Error(r.message);
    const other = await confirmedOrder();
    const base = { orderId: other.id, issuedAt: new Date(), supplyType: "intra", taxableTotal: 100, cgstTotal: 5, sgstTotal: 5, igstTotal: 0, total: 110, payload: "{}" };
    await expect(db.invoice.create({ data: { ...base, number: r.invoice.number, financialYear: "2026-27", seq: 99 } })).rejects.toThrow(/Unique constraint/);
    await expect(db.invoice.create({ data: { ...base, number: "VV/26-27/000050", financialYear: "2026-27", seq: 50, total: 111 } })).rejects.toThrow(/Invoice_values_check/);
    await expect(db.invoice.create({ data: { ...base, number: "VV/26-27/0000500000", financialYear: "2026-27", seq: 51 } })).rejects.toThrow(/Invoice_values_check/);
    await expect(db.invoice.create({ data: { ...base, number: "VV/26-27/000052", financialYear: "2026-27", seq: 0 } })).rejects.toThrow(/Invoice_values_check/);
  });
});

describe("an issued invoice is frozen", () => {
  it("regenerates byte-for-byte, even after the rates, the seller settings and the catalogue change", async () => {
    const o = await confirmedOrder({ quantity: 2 });
    const r = await issueInvoice(o.id, new Date("2026-11-12T10:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    const before = sha(renderInvoicePdf(JSON.parse(r.invoice.payload)));
    await setRate("0802", 1800, "2025-01-01");
    await db.variant.update({ where: { id: variantId }, data: { hsCode: "99999999", price: 77777 } });
    vi.stubEnv("SELLER_GSTIN", "");
    const again = await db.invoice.findUniqueOrThrow({ where: { id: r.invoice.id } });
    expect(sha(renderInvoicePdf(JSON.parse(again.payload)))).toBe(before);
    await db.variant.update({ where: { id: variantId }, data: { hsCode: "0802", price: 10500 } });
  });

  it("the admin endpoint serves the same PDF every time, and the JSON of the frozen payload", async () => {
    const o = await confirmedOrder();
    const r = await issueInvoice(o.id);
    if (!r.ok) throw new Error(r.message);
    const get = (q = "") => invoiceGet(mk(`/api/admin/invoices/${r.invoice.id}${q}`, "GET", admin.cookie), { params: Promise.resolve({ id: r.invoice.id }) });
    const a = await get();
    expect(a.headers.get("content-type")).toBe("application/pdf");
    expect(a.headers.get("content-disposition")).toBe(`inline; filename="VV-26-27-${String(r.invoice.seq).padStart(6, "0")}.pdf"`.replace(/VV-26-27/, r.invoice.number.replace(/\//g, "-").slice(0, 8)));
    const bytes = new Uint8Array(await a.arrayBuffer());
    expect(sha(new Uint8Array(await (await get()).arrayBuffer()))).toBe(sha(bytes));
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    expect((await (await get("?format=json")).json()).invoice.number).toBe(r.invoice.number);
    expect((await invoiceGet(mk("/api/admin/invoices/none", "GET", admin.cookie), { params: Promise.resolve({ id: "none" }) })).status).toBe(404);
  });
});

describe("admin issuing endpoint and listing", () => {
  const issue = (id: string, cookie = admin.cookie) => issueRoute(mk(`/api/admin/orders/${id}/invoice`, "POST", cookie), { params: Promise.resolve({ id }) });

  it("201 on first issue, 200 on repeat, 409 with details when something is missing, 404 unknown; audited", async () => {
    const o = await confirmedOrder();
    const first = await issue(o.id);
    expect(first.status).toBe(201);
    expect((await issue(o.id)).status).toBe(200);
    await db.taxRate.deleteMany({});
    const o2 = await confirmedOrder();
    const missing = await issue(o2.id);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "tax_not_configured", detail: ["0802"] });
    expect((await issue("none")).status).toBe(404);
    expect((await db.auditLog.findMany({ where: { action: "invoice.issue" } })).length).toBe(4);
    const viewer = await createTestAdmin("viewer");
    expect((await issue(o.id, viewer.cookie)).status).toBe(403);
    expect((await issue(o.id, "")).status).toBe(401);
  });

  it("lists invoices newest first with totals and filters by financial year", async () => {
    const [a, b] = [await confirmedOrder(), await confirmedOrder()];
    await issueInvoice(a.id, new Date("2026-05-01T10:00:00Z"));
    await issueInvoice(b.id, new Date("2027-05-01T10:00:00Z"));
    const all = await (await invoiceList(mk("/api/admin/invoices", "GET", admin.cookie))).json();
    expect(all.invoices.map((i: any) => i.number)).toEqual(["VV/27-28/000001", "VV/26-27/000001"]);
    expect(all.invoices[0]).toMatchObject({ total: b.total, taxable: expect.any(Number), cgst: expect.any(Number) });
    const fy = await (await invoiceList(mk("/api/admin/invoices?fy=2026-27", "GET", admin.cookie))).json();
    expect(fy.invoices).toHaveLength(1);
    expect((await invoiceList(mk("/api/admin/invoices?fy=bad", "GET", admin.cookie))).status).toBe(422);
  });
});

describe("customer access to their invoice", () => {
  it("downloads the PDF of their own invoiced order only: others', uninvoiced and unknown are the same 404", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const mine = await createOrder({ ...SHIP_TO_KA, paymentMethod: "cod", items: [{ variantId, quantity: 1 }] }, { customerId: a.customerId });
    await confirm(mine.id);
    const uninvoiced = await createOrder({ ...SHIP_TO_KA, paymentMethod: "cod", items: [{ variantId, quantity: 1 }] }, { customerId: a.customerId });
    await issueInvoice(mine.id);
    const get = (number: string, cookie?: string) => accountInvoice(mk(`/api/account/orders/${number}/invoice`, "GET", cookie), { params: Promise.resolve({ number }) });
    const ok = await get(mine.number, a.cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment; filename="VV-26-27-\d{6}\.pdf"$/);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    for (const [who, num] of [[b.cookie, mine.number], [a.cookie, uninvoiced.number], [a.cookie, "VV-000000-NOPE00"]] as const) expect((await get(num, who)).status).toBe(404);
    expect((await get(mine.number)).status).toBe(401);
  });
});

describe("an invoiced order cannot be cancelled (no credit notes yet)", () => {
  it("the state machine and the admin PATCH both refuse, and nothing changes", async () => {
    const o = await confirmedOrder();
    await issueInvoice(o.id);
    const r = await transitionOrder({ orderId: o.id, from: "confirmed", to: "cancelled", actor: ADMIN_TRANSITION, reason: "customer asked" });
    expect(r).toMatchObject({ ok: false, code: "invoice_issued" });
    const res = await orderPatch(mk(`/api/admin/orders/${o.id}`, "PATCH", admin.cookie, { status: "cancelled", reason: "customer asked" }), { params: Promise.resolve({ id: o.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("invoice_issued");
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("confirmed");
    // the normal lifecycle continues
    expect((await transitionOrder({ orderId: o.id, from: "confirmed", to: "dispatched", actor: ADMIN_TRANSITION, reason: "shipped" })).ok).toBe(true);
    // an order WITHOUT an invoice can still be cancelled
    const plain = await placeCod(variantId);
    expect((await transitionOrder({ orderId: plain.id, from: "pending_confirmation", to: "cancelled", actor: ADMIN_TRANSITION, reason: "x" })).ok).toBe(true);
  });

  it("test-data cleanup leaves invoiced orders alone", async () => {
    const o = await confirmedOrder();
    await issueInvoice(o.id);
    const { DELETE } = await import("@/app/api/admin/test-data/route");
    await DELETE(new Request("http://localhost/api/admin/test-data", { method: "DELETE", headers: { cookie: admin.cookie, host: "localhost" } }));
    expect(await db.order.count({ where: { id: o.id } })).toBe(1);
    expect(await db.invoice.count({ where: { orderId: o.id } })).toBe(1);
  });
});
