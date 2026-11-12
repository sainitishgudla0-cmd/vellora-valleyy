import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import { buildInvoicePayload, type InvoicePayload } from "@/lib/invoices/payload";
import { splitInclusive } from "@/lib/tax/calc";
import { renderTemplate, TEMPLATES, escapeHtml, type TemplateVars } from "@/lib/notify/templates";
import { backoffFor, BACKOFF_MS, MAX_ATTEMPTS } from "@/lib/notify/dispatch";

const seller = { legalName: "Anantha Food Products", gstin: "37AAAAA0000A1Z9", address: { line1: "2-29-1 KM Colony, JNTU Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002" }, stateCode: "37", fssai: "10126013000012" };

function payload(over: { supply?: "intra" | "inter"; lines?: number; hostile?: boolean; delivery?: number; business?: boolean } = {}): InvoicePayload {
  const supply = over.supply ?? "intra";
  const n = over.lines ?? 2;
  return buildInvoicePayload({
    number: "VV/26-27/000007",
    issuedAt: new Date("2026-11-12T10:00:00Z"),
    financialYear: "2026-27",
    supplyType: supply,
    seller,
    order: { number: "VV-261112-ABC123", createdAt: new Date("2026-11-11T09:00:00Z"), customerName: over.hostile ? "Asha (Rao) \\ ₹ అశ" : "Asha Rao", addressLine1: "12 MG Road", addressLine2: null, city: "Anantapur", state: supply === "intra" ? "Andhra Pradesh" : "Karnataka", pincode: "515001" },
    business: over.business ? { companyName: "Rao Traders", gstin: "29AAAAA0000A1Z5" } : null,
    buyerStateCode: supply === "intra" ? "37" : "29",
    lines: Array.from({ length: n }, (_, i) => ({ productName: `Premium Cashews ${i + 1}`, variantLabel: "250g", hsCode: "08013220", quantity: i + 1, unitPrice: 10500, lineTotal: 10500 * (i + 1), split: splitInclusive(10500 * (i + 1), 500, supply) })),
    deliveryFee: over.delivery ?? 0,
    deliverySplit: over.delivery ? splitInclusive(over.delivery, 1800, supply) : null,
  });
}

describe("invoice payload", () => {
  it("totals are the exact sum of the lines (and of the delivery charge) and nothing else", () => {
    const p = payload({ lines: 3, delivery: 5900 });
    const lineSum = p.lines.reduce((s, l) => s + l.total, 0);
    expect(p.totals.total).toBe(lineSum + 5900);
    expect(p.totals.taxableValue + p.totals.cgst + p.totals.sgst + p.totals.igst).toBe(p.totals.total);
    expect(p.delivery).toMatchObject({ total: 5900, rateBp: 1800 });
    expect(p.reverseCharge).toBe(false);
  });
  it("inter-state invoices carry IGST only; B2B invoices carry the buyer's GSTIN and company", () => {
    const p = payload({ supply: "inter", business: true });
    expect(p.totals.cgst + p.totals.sgst).toBe(0);
    expect(p.totals.igst).toBeGreaterThan(0);
    expect(p.buyer).toMatchObject({ company: "Rao Traders", gstin: "29AAAAA0000A1Z5", stateCode: "29" });
    expect(payload().buyer.gstin).toBeNull();
  });
});

describe("invoice PDF", () => {
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

  it("is deterministic: the same payload always produces the same bytes", () => {
    const p = payload({ lines: 4, delivery: 5900 });
    const a = renderInvoicePdf(p);
    expect(sha(renderInvoicePdf(JSON.parse(JSON.stringify(p))))).toBe(sha(a)); // also after a JSON round trip (what is stored)
    expect(sha(renderInvoicePdf(payload({ lines: 4, delivery: 5900 })))).toBe(sha(a));
    expect(sha(renderInvoicePdf(payload({ lines: 5, delivery: 5900 })))).not.toBe(sha(a));
  });

  it("is a well-formed PDF: header, trailer, and an xref table whose offsets point at the objects", () => {
    const buf = renderInvoicePdf(payload({ lines: 3 }));
    const s = buf.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    const size = Number(/trailer\n<< \/Size (\d+)/.exec(s)![1]);
    const entries = [...s.slice(startxref).matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
    expect(entries.length).toBe(size);
    for (let n = 1; n < size; n++) expect(s.slice(Number(entries[n][1])).startsWith(`${n} 0 obj`), `object ${n}`).toBe(true);
    // every stream's /Length matches its bytes
    for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(Buffer.byteLength(m[2], "latin1")).toBe(Number(m[1]));
  });

  it("shows the legal content: number, supplier and buyer GSTIN, HSN, supply type, totals", () => {
    const s = renderInvoicePdf(payload({ business: true, supply: "inter", delivery: 5900 })).toString("latin1");
    for (const needle of ["TAX INVOICE", "VV/26-27/000007", "37AAAAA0000A1Z9", "29AAAAA0000A1Z5", "08013220", "Inter-state \\(IGST\\)", "IGST", "FSSAI: 10126013000012", "Delivery charges", "Place of supply: Karnataka \\(29\\)"]) expect(s, needle).toContain(needle);
    const intra = renderInvoicePdf(payload()).toString("latin1");
    expect(intra).toContain("Intra-state \\(CGST + SGST\\)"); // parentheses are escaped inside PDF strings
    expect(intra).toContain("CGST");
    expect(intra).toContain("SGST");
  });

  it("survives hostile and non-Latin text (escaped, no broken syntax) and spreads many lines over pages", () => {
    const s = renderInvoicePdf(payload({ hostile: true })).toString("latin1");
    expect(s).toContain("Asha \\(Rao\\) \\\\ Rs. ??");
    const many = renderInvoicePdf(payload({ lines: 70 }));
    expect(/\/Count (\d+)/.exec(many.toString("latin1"))![1]).not.toBe("1");
    expect(Number(/\/Count (\d+)/.exec(many.toString("latin1"))![1])).toBeGreaterThanOrEqual(2);
  });
});

describe("notification templates", () => {
  const vars: TemplateVars = { brand: "Velora Valley", customerName: "Asha <b>Rao</b>", orderNumber: "VV-1", orderUrl: "https://shop.example/order/VV-1?t=tok&x=1", total: 123456, items: [{ name: "Cashews & Co", label: "250g", quantity: 2 }], courier: "Delhivery", awb: "DL1", trackingUrl: "https://t.example/DL1", invoiceNumber: "VV/26-27/000001", quoteNumber: "QT-1", quoteTotal: 500000, quoteValidUntil: "2026-12-01", paymentMethod: "cod", paymentStatus: "unpaid" };
  it.each(TEMPLATES)("%s renders a complete message with no placeholders", (t) => {
    const m = renderTemplate(t, vars);
    expect(m.subject.length).toBeGreaterThan(5);
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/undefined|NaN|\[object|\{\{/);
    expect(m.text).toContain("Velora Valley");
  });
  it("escapes every variable in HTML but leaves the plain-text part readable", () => {
    const m = renderTemplate("order_placed", vars);
    expect(m.html).not.toContain("<b>Rao</b>");
    expect(m.html).toContain("Asha &lt;b&gt;Rao&lt;/b&gt;");
    expect(m.html).toContain("Cashews &amp; Co");
    expect(m.html).toContain('href="https://shop.example/order/VV-1?t=tok&amp;x=1"');
    expect(m.text).toContain("Asha <b>Rao</b>");
    expect(escapeHtml(`<"'&>`)).toBe("&lt;&quot;&#39;&amp;&gt;");
  });
  it("content matches the event", () => {
    expect(renderTemplate("order_dispatched", vars).text).toMatch(/Courier: Delhivery[\s\S]*Tracking number: DL1[\s\S]*https:\/\/t\.example\/DL1/);
    expect(renderTemplate("order_placed", vars).text).toMatch(/Rs\. 1,234\.56/);
    expect(renderTemplate("order_placed", vars).text).toMatch(/pay on delivery/i);
    expect(renderTemplate("order_cancelled", { ...vars, paymentStatus: "paid" }).text).toMatch(/refund/);
    expect(renderTemplate("order_cancelled", vars).text).toMatch(/No payment was taken/);
    expect(renderTemplate("quote_ready", vars).text).toMatch(/Rs\. 5,000\.00[\s\S]*Valid until 2026-12-01/);
    expect(renderTemplate("invoice_issued", vars).subject).toContain("VV/26-27/000001");
  });
});

describe("retry schedule", () => {
  it("backs off 1 min, 5 min, 30 min, 2 h, 6 h and then stays at the cap; six attempts in all", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffFor)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000, 21_600_000]);
    expect(BACKOFF_MS).toHaveLength(5);
    expect(MAX_ATTEMPTS).toBe(6);
  });
});
