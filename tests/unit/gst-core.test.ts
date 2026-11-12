import { describe, expect, it } from "vitest";
import { splitInclusive, sumSplits, supplyTypeFor } from "@/lib/tax/calc";
import { GST_STATE_CODES, stateCode } from "@/lib/tax/states";
import { hsnCandidates, asOfDay } from "@/lib/tax/rates";
import { resolveSeller } from "@/lib/tax/seller";
import { gstinCheckChar } from "@/lib/wholesale/gstin";
import { INDIAN_STATES } from "@/lib/validation";
import { financialYear, formatInr, formatRate, invoiceNumber } from "@/lib/invoices/format";
import { matchRule, quoteFromRules } from "@/lib/shipping/rules";
import { SHIPMENT_TRANSITIONS } from "@/lib/shipping/shipments";
import { resolveNotifyConfig, NotifyConfigError } from "@/lib/env/notify-config";
import { shipmentCreateSchema, shippingRulePatchSchema, shippingRuleSchema, taxRateSchema } from "@/lib/fulfilment/schemas";

/**
 * Tax fixtures. The rates here are ILLUSTRATIVE test values (5%, 12%, 18%), not statements of what GST applies to any product:
 * the real rate per HSN is set by the business with its accountant's sign-off (ADR 0015). The point of these tests is the
 * arithmetic: GST-inclusive amounts split into taxable value + CGST/SGST or IGST, exact to the paisa.
 */
describe("GST split of a GST-inclusive amount (paise exact)", () => {
  const FIXTURES: [string, number, number, "intra" | "inter", { taxableValue: number; cgst: number; sgst: number; igst: number }][] = [
    ["Rs 105.00 @5%, intra", 10500, 500, "intra", { taxableValue: 10000, cgst: 250, sgst: 250, igst: 0 }],
    ["Rs 105.00 @5%, inter", 10500, 500, "inter", { taxableValue: 10000, cgst: 0, sgst: 0, igst: 500 }],
    ["Rs 118.00 @18%, intra", 11800, 1800, "intra", { taxableValue: 10000, cgst: 900, sgst: 900, igst: 0 }],
    ["Rs 112.00 @12%, intra", 11200, 1200, "intra", { taxableValue: 10000, cgst: 600, sgst: 600, igst: 0 }],
    ["Rs 10.00 @5% (tax rounds up from 47.6 paise)", 1000, 500, "intra", { taxableValue: 952, cgst: 24, sgst: 24, igst: 0 }],
    ["14 paise @12%: exactly half a paisa rounds up", 14, 1200, "inter", { taxableValue: 12, cgst: 0, sgst: 0, igst: 2 }],
    ["odd tax: SGST takes the odd paisa", 10000, 500, "intra", { taxableValue: 9524, cgst: 238, sgst: 238, igst: 0 }], // tax 476 even; below uses 9999
    ["odd tax 477", 10020, 500, "intra", { taxableValue: 9543, cgst: 238, sgst: 239, igst: 0 }],
    ["0% rate: everything is taxable value", 25000, 0, "intra", { taxableValue: 25000, cgst: 0, sgst: 0, igst: 0 }],
    ["zero amount", 0, 1800, "intra", { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 }],
    ["1 paisa @5% has no tax", 1, 500, "inter", { taxableValue: 1, cgst: 0, sgst: 0, igst: 0 }],
    ["fractional rate 2.5%", 10250, 250, "intra", { taxableValue: 10000, cgst: 125, sgst: 125, igst: 0 }],
    ["large amount Rs 1,00,00,000 @18%", 1_000_000_000, 1800, "inter", { taxableValue: 847_457_627, cgst: 0, sgst: 0, igst: 152_542_373 }],
  ];
  it.each(FIXTURES)("%s", (_n, amount, rate, supply, expected) => {
    const s = splitInclusive(amount, rate, supply);
    expect(s).toMatchObject({ ...expected, rateBp: rate });
    expect(s.taxableValue + s.cgst + s.sgst + s.igst).toBe(amount); // never a paisa lost or invented
  });

  it("invariants over 20,000 amount x rate x supply combinations", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) % 4294967296) % n);
    for (let i = 0; i < 20_000; i++) {
      const amount = rnd(5) === 0 ? rnd(200) : rnd(100_000_000);
      const rate = [0, 100, 250, 500, 1200, 1800, 2800, 4000][rnd(8)];
      const supply = rnd(2) ? "intra" : "inter";
      const s = splitInclusive(amount, rate, supply);
      const tax = s.cgst + s.sgst + s.igst;
      expect(s.taxableValue + tax).toBe(amount);
      expect(s.taxableValue).toBeGreaterThanOrEqual(0);
      // tax is the nearest integer to amount x rate / (1 + rate): |tax x d - amount x rate| <= d / 2 in exact integer arithmetic
      const d = 10_000 + rate;
      expect(Math.abs(tax * d - amount * rate)).toBeLessThanOrEqual(d / 2);
      if (supply === "intra") {
        expect(s.igst).toBe(0);
        expect(s.sgst - s.cgst).toBeGreaterThanOrEqual(0);
        expect(s.sgst - s.cgst).toBeLessThanOrEqual(1);
      } else expect(s.cgst + s.sgst).toBe(0);
    }
  });

  it("an invoice's totals are the sum of its lines (line-level rounding), and equal the order total", () => {
    const lines = [4999, 12345, 777, 100000].map((a) => splitInclusive(a, 1200, "intra"));
    const t = sumSplits(lines);
    expect(t.taxableValue + t.cgst + t.sgst + t.igst).toBe(4999 + 12345 + 777 + 100000);
  });

  it("rejects nonsense", () => {
    for (const bad of [-1, 1.5, NaN]) expect(() => splitInclusive(bad, 500, "intra")).toThrow(RangeError);
    for (const bad of [-1, 5001, 1.5]) expect(() => splitInclusive(100, bad, "intra")).toThrow(RangeError);
  });
});

describe("supply type and state codes", () => {
  it("intra when the place of supply is the seller's state, inter otherwise (and when the state is unknown)", () => {
    expect(supplyTypeFor("37", "37")).toBe("intra");
    expect(supplyTypeFor("37", "29")).toBe("inter");
    expect(supplyTypeFor("37", null)).toBe("inter");
  });
  it("every state the shop accepts has a GST code; Andhra Pradesh is 37; codes are unique except none shared", () => {
    for (const s of INDIAN_STATES) expect(stateCode(s), s).toMatch(/^\d{2}$/);
    expect(stateCode("Andhra Pradesh")).toBe("37");
    expect(stateCode("Telangana")).toBe("36");
    expect(stateCode("Atlantis")).toBeNull();
    const codes = Object.values(GST_STATE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("rate lookup helpers", () => {
  it("an HSN falls back to its 6- and 4-digit parents, most specific first", () => {
    expect(hsnCandidates("08041020")).toEqual(["08041020", "080410", "0804"]);
    expect(hsnCandidates("080212")).toEqual(["080212", "0802"]);
    expect(hsnCandidates("0804")).toEqual(["0804"]);
  });
  it("the as-of day is the calendar day in India", () => {
    expect(asOfDay(new Date("2026-03-31T18:29:59Z")).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(asOfDay(new Date("2026-03-31T18:30:00Z")).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("seller configuration", () => {
  const body = "37AAAAA0000A1Z";
  const gstin = body + gstinCheckChar(body);
  it("needs a well-formed GSTIN whose state code matches the registered state", () => {
    expect(resolveSeller({})).toMatchObject({ ok: false, issues: ["SELLER_GSTIN is not set."] });
    const bad = resolveSeller({ SELLER_GSTIN: "37AAAAA0000A1ZX" });
    expect(bad.ok).toBe(false);
    const other = "29AAAAA0000A1Z";
    const wrongState = resolveSeller({ SELLER_GSTIN: other + gstinCheckChar(other) });
    expect(wrongState).toMatchObject({ ok: false });
    if (!wrongState.ok) expect(wrongState.issues.join()).toMatch(/starts with 29/);
    const ok = resolveSeller({ SELLER_GSTIN: ` ${gstin.toLowerCase()} `, SELLER_LEGAL_NAME: "Anantha Food Products" });
    expect(ok).toMatchObject({ ok: true, seller: { gstin, stateCode: "37", legalName: "Anantha Food Products" } });
  });
});

describe("invoice numbering and money formatting", () => {
  it("financial year runs April-March by the Indian calendar", () => {
    expect(financialYear(new Date("2026-03-31T18:29:59Z"))).toBe("2025-26");
    expect(financialYear(new Date("2026-03-31T18:30:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2026-11-12T00:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2027-03-31T12:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2099-04-01T00:00:00+05:30"))).toBe("2099-00");
    expect(financialYear(new Date("2026-01-01T00:00:00Z"))).toBe("2025-26");
  });
  it("numbers are at most 16 characters of letters, digits, / and -", () => {
    const n = invoiceNumber("2026-27", 1);
    expect(n).toBe("VV/26-27/000001");
    expect(invoiceNumber("2026-27", 999_999)).toBe("VV/26-27/999999");
    for (const x of [n, invoiceNumber("2099-00", 123456)]) {
      expect(x.length).toBeLessThanOrEqual(16);
      expect(x).toMatch(/^[A-Za-z0-9/-]+$/);
    }
    for (const bad of [0, -1, 1_000_000, 1.5]) expect(() => invoiceNumber("2026-27", bad)).toThrow(RangeError);
  });
  it("Indian digit grouping and rates", () => {
    expect(formatInr(0)).toBe("0.00");
    expect(formatInr(5)).toBe("0.05");
    expect(formatInr(99999)).toBe("999.99");
    expect(formatInr(100000)).toBe("1,000.00");
    expect(formatInr(12345678)).toBe("1,23,456.78");
    expect(formatInr(123456789)).toBe("12,34,567.89");
    expect(formatInr(1_000_000_000)).toBe("1,00,00,000.00");
    expect(formatInr(-150)).toBe("-1.50");
    expect(formatRate(1800)).toBe("18%");
    expect(formatRate(250)).toBe("2.5%");
    expect(formatRate(0)).toBe("0%");
  });
});

describe("shipping rules", () => {
  const rule = (id: string, pincodePrefix: string, o: Partial<{ serviceable: boolean; fee: number; freeAboveSubtotal: number | null }> = {}) => ({ id, pincodePrefix, serviceable: true, fee: 0, freeAboveSubtotal: null, ...o });
  it("no rules: legacy behaviour (everywhere, site default fee)", () => {
    expect(quoteFromRules([], "515001", 100)).toMatchObject({ serviceable: true, fee: 0, legacy: true });
  });
  it("the longest matching prefix wins; the empty prefix is the catch-all", () => {
    const rules = [rule("all", "", { fee: 9900 }), rule("ap", "5", { fee: 4900 }), rule("atp", "515", { fee: 2500 }), rule("exact", "515001", { fee: 0 })];
    expect(matchRule(rules, "515001")?.id).toBe("exact");
    expect(matchRule(rules, "515002")?.id).toBe("atp");
    expect(matchRule(rules, "500001")?.id).toBe("ap");
    expect(matchRule(rules, "110001")?.id).toBe("all");
    expect(quoteFromRules(rules, "515002", 100)).toMatchObject({ serviceable: true, fee: 2500, ruleId: "atp", legacy: false });
  });
  it("with rules present, a pincode no rule covers is not serviceable; a rule can exclude an area", () => {
    expect(quoteFromRules([rule("ap", "5")], "110001", 100)).toMatchObject({ serviceable: false, fee: 0 });
    expect(quoteFromRules([rule("all", ""), rule("island", "682", { serviceable: false })], "682001", 100)).toMatchObject({ serviceable: false });
    expect(quoteFromRules([rule("all", ""), rule("island", "682", { serviceable: false })], "110001", 100).serviceable).toBe(true);
  });
  it("free-shipping threshold is inclusive", () => {
    const rules = [rule("ap", "5", { fee: 5000, freeAboveSubtotal: 49900 })];
    expect(quoteFromRules(rules, "515001", 49899).fee).toBe(5000);
    expect(quoteFromRules(rules, "515001", 49900).fee).toBe(0);
    expect(quoteFromRules(rules, "515001", 49900).freeAboveSubtotal).toBe(49900);
  });
});

describe("shipment graph", () => {
  it("delivered and returned are terminal; every status is reachable", () => {
    expect(SHIPMENT_TRANSITIONS.delivered).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.returned).toEqual([]);
    const reachable = new Set(["created", ...Object.values(SHIPMENT_TRANSITIONS).flat()]);
    expect(reachable.size).toBe(Object.keys(SHIPMENT_TRANSITIONS).length);
  });
});

describe("notification configuration (fails closed)", () => {
  it("is off by default, mock only in development/test", () => {
    expect(resolveNotifyConfig({ APP_ENV: "development" }).mode).toBe("off");
    expect(resolveNotifyConfig({ APP_ENV: "test", NOTIFY_MODE: "mock" }).mode).toBe("mock");
    expect(resolveNotifyConfig({ APP_ENV: "production" }).warnings.join()).toMatch(/disabled until a real email provider/);
    for (const appEnv of ["preview", "production"]) expect(() => resolveNotifyConfig({ APP_ENV: appEnv, NOTIFY_MODE: "mock" })).toThrow(NotifyConfigError);
    expect(() => resolveNotifyConfig({ APP_ENV: "development", NOTIFY_MODE: "live" })).toThrow(/not one of/);
  });
});

describe("M7 request schemas", () => {
  it("tax rates: HSN or DELIVERY, basis points, a real date", () => {
    expect(taxRateSchema.safeParse({ code: "08041020", rateBp: 500, effectiveFrom: "2026-04-01" }).success).toBe(true);
    expect(taxRateSchema.safeParse({ code: "delivery", rateBp: 1800, effectiveFrom: "2026-04-01" })).toMatchObject({ success: true, data: { code: "DELIVERY" } });
    for (const bad of [{ code: "123", rateBp: 500, effectiveFrom: "2026-04-01" }, { code: "0804", rateBp: 5001, effectiveFrom: "2026-04-01" }, { code: "0804", rateBp: 5.5, effectiveFrom: "2026-04-01" }, { code: "0804", rateBp: 500, effectiveFrom: "2026-13-40" }, { code: "0804", rateBp: 500, effectiveFrom: "01/04/2026" }, { code: "0804", rateBp: 500, effectiveFrom: "2026-04-01", extra: 1 }]) expect(taxRateSchema.safeParse(bad).success).toBe(false);
  });
  it("shipping rules and shipments", () => {
    expect(shippingRuleSchema.safeParse({ name: "Anantapur", pincodePrefix: "515", fee: 2500 }).success).toBe(true);
    expect(shippingRuleSchema.safeParse({ name: "All", pincodePrefix: "" }).success).toBe(true);
    for (const bad of [{ name: "x", pincodePrefix: "5" }, { name: "Bad", pincodePrefix: "12a" }, { name: "Bad", pincodePrefix: "1234567" }, { name: "Neg", pincodePrefix: "5", fee: -1 }, { name: "Free", pincodePrefix: "5", freeAboveSubtotal: 0 }]) expect(shippingRuleSchema.safeParse(bad).success).toBe(false);
    expect(shippingRuleSchema.parse({ name: "Plain", pincodePrefix: "5" })).toMatchObject({ serviceable: true, fee: 0, active: true }); // create applies defaults
    expect(shippingRulePatchSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" }); // a patch carries ONLY what was sent
    expect(shippingRulePatchSchema.safeParse({}).success).toBe(false);
    expect(shipmentCreateSchema.safeParse({ courier: "Delhivery", awb: "DL1234567890", trackingUrl: "https://track.example.com/x" }).success).toBe(true);
    for (const bad of [{ courier: "D", awb: "DL1234567890" }, { courier: "Delhivery", awb: "no spaces allowed" }, { courier: "Delhivery", awb: "AB1" }, { courier: "Delhivery", awb: "DL123456", trackingUrl: "http://insecure.example.com" }, { courier: "Delhivery", awb: "DL123456", trackingUrl: "javascript:alert(1)" }]) expect(shipmentCreateSchema.safeParse(bad).success).toBe(false);
  });
});
