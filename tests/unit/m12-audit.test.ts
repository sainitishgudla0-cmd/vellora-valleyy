/** M12 independent audit, pure parts: VA-07 (invoice PDF text) and VA-08 (client address for rate limits). */
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/lib/invoices/pdf";
import { toPdfText } from "@/lib/invoices/pdf-text";
import { buildInvoicePayload } from "@/lib/invoices/payload";
import { splitInclusive } from "@/lib/tax/calc";
import { clientIp } from "@/lib/client-ip";

const seller = { legalName: "Anantha Food Products", gstin: "37AAAAA0000A1Z9", address: { line1: "2-29-1 KM Colony, JNTU Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002" }, stateCode: "37", fssai: "10126013000012" };
function pdfFor(customerName: string, addressLine1 = "12 MG Road", productName = "Premium Cashews") {
  const p = buildInvoicePayload({
    number: "VV/26-27/000007", issuedAt: new Date("2026-11-12T10:00:00Z"), financialYear: "2026-27", supplyType: "intra", seller,
    order: { number: "VV-261112-ABC123", createdAt: new Date("2026-11-11T09:00:00Z"), customerName, addressLine1, addressLine2: null, city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" },
    business: null, buyerStateCode: "37",
    lines: [{ productName, variantLabel: "250g", hsCode: "08013220", quantity: 1, unitPrice: 10500, lineTotal: 10500, split: splitInclusive(10500, 500, "intra") }],
    deliveryFee: 0, deliverySplit: null,
  });
  return renderInvoicePdf(p).toString("latin1");
}

describe("VA-07 invoice text is legible for Indian names and everyday punctuation", () => {
  it("Telugu, Devanagari and Tamil names are transliterated, never printed as question marks", () => {
    expect(toPdfText("శ్రీనివాస్ రెడ్డి")).toBe("Shriinivaas Reddi");
    expect(toPdfText("अनंता फूड")).toBe("Anamtaa Phuud");
    expect(toPdfText("முருகன்")).toBe("Murukan"); // Tamil script does not distinguish k and g
    for (const name of ["శ్రీనివాస్ రెడ్డి", "राम कुमार", "ಅನಂತ", "മലയാളം", "বাংলা", "ગુજરાતી", "ਪੰਜਾਬ", "ଓଡ଼ିଆ"]) expect(toPdfText(name), name).not.toMatch(/\?/);
  });

  it("phone-keyboard punctuation keeps its WinAnsi glyph instead of '?'", () => {
    expect(toPdfText("D’Souza – “Café” …")).toBe("D\u0092Souza \u0096 \u0093Café\u0094 \u0085");
  });

  it("decomposed accents (NFD input) and Latin letters outside Latin-1 fold to a readable form", () => {
    expect(toPdfText("José")).toBe("José");
    expect(toPdfText("Śrī Kṛṣṇa")).toBe("Sri Krsna");
  });

  it("anything else becomes a single '?' per character (an emoji is one character, not two)", () => {
    expect(toPdfText("A🙂B")).toBe("A?B");
    expect(toPdfText("₹ 100")).toBe("Rs. 100");
  });

  it("is idempotent, so fitting a column before drawing it changes nothing", () => {
    for (const t of ["శ్రీనివాస్", "D’Souza – x", "José", "plain"]) expect(toPdfText(toPdfText(t))).toBe(toPdfText(t));
  });

  it("the rendered PDF carries the transliterated buyer name, address and product", () => {
    const s = pdfFor("శ్రీనివాస్ రెడ్డి", "ఇంటి నం 12, గాంధీ రోడ్", "జీడిపప్పు");
    expect(s).toContain("(Shriinivaas Reddi)");
    expect(s).toContain("Gaamdhii");
    expect(s).toContain("Jiidipappu");
    expect(s).not.toMatch(/\(\?+[ ,]/);
  });

  it("column fitting counts characters, not UTF-16 units, and still escapes PDF syntax", () => {
    const s = pdfFor(`${"🙂".repeat(60)}`);
    expect(s).toMatch(/\(\?{43}\.\)/); // 44 visible characters including the ellipsis dot
    expect(pdfFor("Asha (Rao) \\")).toContain("Asha \\(Rao\\) \\\\");
  });
});

describe("VA-08 the client address used for rate limits cannot be chosen by the client", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("behind a trusted proxy that appends the address (default: one hop) a forged leading entry is ignored", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), {})).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" }), {})).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), {})).toBe("203.0.113.7");
  });

  it("rotating forged values does not produce new keys", () => {
    const keys = new Set(Array.from({ length: 20 }, (_, i) => clientIp(h({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` }), {})));
    expect([...keys]).toEqual(["203.0.113.7"]);
  });

  it("X-Real-IP is only trusted on Vercel, which sets it itself", () => {
    expect(clientIp(h({ "x-real-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.7" }), {})).toBe("203.0.113.7");
    expect(clientIp(h({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "198.51.100.4" }), { VERCEL: "1" })).toBe("198.51.100.4");
  });

  it("TRUSTED_PROXY_HOPS counts proxies from the right; too few entries is one shared 'untrusted' key", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }), { TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), { TRUSTED_PROXY_HOPS: "2" })).toBe("untrusted");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6" }), { TRUSTED_PROXY_HOPS: "0" })).toBe("direct");
    expect(clientIp(h({}), {})).toBe("local");
  });

  it("an invalid TRUSTED_PROXY_HOPS falls back to one hop", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), { TRUSTED_PROXY_HOPS: "lots" })).toBe("203.0.113.7");
  });
});
