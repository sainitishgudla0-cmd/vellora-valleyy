import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gstinCheckChar, normalizeGstin, validateGstin } from "@/lib/wholesale/gstin";
import { NO_RESTRICTION, pickTier, quantityProblem, resolveUnitPrice } from "@/lib/wholesale/rules";
import { QUOTE_TRANSITIONS, validateQuoteTransition } from "@/lib/wholesale/quote-machine";
import { ACCOUNT_TRANSITIONS } from "@/lib/wholesale/accounts";
import { applySchema, businessOrderSchema, convertSchema, priceTiersSchema, quoteActionSchema, quoteRequestSchema } from "@/lib/wholesale/schemas";

describe("GSTIN", () => {
  it("accepts a real-format GSTIN with a correct check character (published sample)", () => {
    expect(validateGstin("27AAPFU0939F1ZV")).toEqual({ ok: true, gstin: "27AAPFU0939F1ZV" });
  });
  it("normalises case and whitespace", () => {
    expect(normalizeGstin(" 27aapfu0939f1zv ")).toBe("27AAPFU0939F1ZV");
    expect(validateGstin(" 27aapfu 0939f1zv ")).toMatchObject({ ok: true, gstin: "27AAPFU0939F1ZV" });
  });
  it("computes the check character from the first 14", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
  });
  it.each([
    ["wrong check character", "27AAPFU0939F1ZW", /check character/],
    ["too short", "27AAPFU0939F1Z", /15 characters/],
    ["too long", "27AAPFU0939F1ZVV", /15 characters/],
    ["bad state code", "00AAPFU0939F1ZV", /valid GSTIN/],
    ["state code above 38", "45AAPFU0939F1ZV", /valid GSTIN/],
    ["digits where PAN letters go", "271APFU0939F1ZV", /valid GSTIN/],
    ["no fixed Z", "27AAPFU0939F1AV", /valid GSTIN/],
    ["entity number 0", "27AAPFU0939F0ZV", /valid GSTIN/],
    ["symbols", "27AAPFU0939F1Z!", /valid GSTIN/],
    ["empty", "", /15 characters/],
  ])("rejects %s", (_n, g, msg) => {
    const r = validateGstin(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
  it("flipping any single character of a valid GSTIN is detected (check char or format)", () => {
    const valid = "27AAPFU0939F1ZV";
    let missed = 0;
    for (let i = 0; i < 15; i++) for (const ch of "0123456789ABCXYZ") if (ch !== valid[i] && validateGstin(valid.slice(0, i) + ch + valid.slice(i + 1)).ok) missed++;
    expect(missed).toBe(0); // the mod-36 check catches every single-character substitution
  });
});

describe("price tiers and quantity rules", () => {
  const tiers = [{ minQty: 10, unitPrice: 900 }, { minQty: 100, unitPrice: 800 }, { minQty: 1000, unitPrice: 700 }];
  it("picks the highest tier the quantity reaches", () => {
    expect(pickTier(tiers, 9)).toBeNull();
    expect(pickTier(tiers, 10)).toEqual(tiers[0]);
    expect(pickTier(tiers, 99)).toEqual(tiers[0]);
    expect(pickTier(tiers, 100)).toEqual(tiers[1]);
    expect(pickTier(tiers, 5000)).toEqual(tiers[2]);
    expect(pickTier([], 50)).toBeNull();
    expect(pickTier([...tiers].reverse(), 150)).toEqual(tiers[1]); // order of rows does not matter
  });
  it("falls back to the retail price below the first tier or without tiers", () => {
    expect(resolveUnitPrice(1000, tiers, 5)).toEqual({ unitPrice: 1000, source: "retail" });
    expect(resolveUnitPrice(1000, [], 500)).toEqual({ unitPrice: 1000, source: "retail" });
    expect(resolveUnitPrice(1000, tiers, 100)).toEqual({ unitPrice: 800, source: "list" });
  });
  it("MOQ and case pack", () => {
    expect(quantityProblem(NO_RESTRICTION, 1)).toBeNull();
    expect(quantityProblem({ moq: 10, casePack: 1 }, 9)).toBe("Minimum order is 10");
    expect(quantityProblem({ moq: 10, casePack: 1 }, 10)).toBeNull();
    expect(quantityProblem({ moq: 1, casePack: 12 }, 13)).toMatch(/multiples of 12/);
    expect(quantityProblem({ moq: 24, casePack: 12 }, 36)).toBeNull();
    expect(quantityProblem({ moq: 24, casePack: 12 }, 12)).toBe("Minimum order is 24");
    for (const bad of [0, -1, 1.5, NaN]) expect(quantityProblem(NO_RESTRICTION, bad)).toMatch(/whole number/);
  });
});

describe("quote lifecycle", () => {
  it("has exactly the documented graph", () => {
    expect(QUOTE_TRANSITIONS).toEqual({
      requested: ["quoted", "rejected", "cancelled"],
      quoted: ["quoted", "accepted", "declined", "expired", "cancelled"],
      accepted: [], declined: [], expired: [], rejected: [], cancelled: [],
    });
  });
  const ALL = Object.keys(QUOTE_TRANSITIONS) as (keyof typeof QUOTE_TRANSITIONS)[];
  it("every pair is either an allowed edge or invalid_transition (full matrix)", () => {
    for (const from of ALL) for (const to of ALL) {
      const allowed = QUOTE_TRANSITIONS[from].includes(to);
      const actor = to === "quoted" || to === "rejected" ? "admin" : to === "accepted" || to === "declined" ? "customer" : to === "expired" ? "system" : "admin";
      const r = validateQuoteTransition(from, to, actor);
      expect(r.ok, `${from}->${to}`).toBe(allowed);
      if (!allowed && !r.ok) expect(r.code).toBe("invalid_transition");
    }
  });
  it("actor rules: only staff price/reject, only the buyer accepts/declines, only the system expires", () => {
    expect(validateQuoteTransition("requested", "quoted", "customer")).toMatchObject({ ok: false, code: "actor_not_allowed" });
    expect(validateQuoteTransition("quoted", "accepted", "admin")).toMatchObject({ ok: false, code: "actor_not_allowed" });
    expect(validateQuoteTransition("quoted", "declined", "admin")).toMatchObject({ ok: false, code: "actor_not_allowed" });
    expect(validateQuoteTransition("quoted", "expired", "customer")).toMatchObject({ ok: false, code: "actor_not_allowed" });
    expect(validateQuoteTransition("quoted", "accepted", "gateway")).toMatchObject({ ok: false, code: "actor_not_allowed" });
    for (const a of ["admin", "customer", "system"] as const) expect(validateQuoteTransition("quoted", "cancelled", a).ok).toBe(true);
  });
  it("account graph: closed is terminal, rejected can only be approved", () => {
    expect(ACCOUNT_TRANSITIONS.closed).toEqual([]);
    expect(ACCOUNT_TRANSITIONS.rejected).toEqual(["approved"]);
    expect(ACCOUNT_TRANSITIONS.pending).toEqual(["approved", "rejected", "closed"]);
  });
});

describe("request schemas", () => {
  const ok = { companyName: "Rao Traders", gstin: "27AAPFU0939F1ZV", contactName: "Asha Rao", phone: "9876543210" };
  it("normalises and validates the GSTIN at the boundary", () => {
    expect(applySchema.safeParse({ ...ok, gstin: " 27aapfu0939f1zv " })).toMatchObject({ success: true, data: { gstin: "27AAPFU0939F1ZV" } });
    expect(applySchema.safeParse({ ...ok, gstin: "27AAPFU0939F1ZW" }).success).toBe(false);
    expect(applySchema.safeParse({ ...ok, businessAccountId: "x" }).success).toBe(false); // strict
    expect(applySchema.safeParse({ ...ok, interest: "nonsense" }).success).toBe(false);
    expect(convertSchema.safeParse({ companyName: "X Foods", gstin: "bad" }).success).toBe(false);
  });
  it("wholesale quantities go far above the retail cap, but are bounded and strict", () => {
    const base = { customerName: "Asha Rao", email: "a@example.com", phone: "9876543210", addressLine1: "12 Market Yard", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" };
    expect(businessOrderSchema.safeParse({ ...base, items: [{ variantId: "v", quantity: 5000 }] }).success).toBe(true);
    expect(businessOrderSchema.safeParse({ ...base, items: [{ variantId: "v", quantity: 100_001 }] }).success).toBe(false);
    expect(businessOrderSchema.safeParse({ ...base, items: [{ variantId: "v", quantity: 1 }], paymentMethod: "razorpay" }).success).toBe(false); // no client-chosen payment method
    expect(businessOrderSchema.safeParse({ ...base, items: [{ variantId: "v", quantity: 1 }], unitPrice: 1 }).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ items: [{ variantId: "v", quantity: 10, unitPrice: 1 }] }).success).toBe(false);
  });
  it("admin tier and quote-action schemas", () => {
    expect(priceTiersSchema.safeParse({ variantId: "v", tiers: [{ minQty: 10, unitPrice: 900 }] }).success).toBe(true);
    expect(priceTiersSchema.safeParse({ variantId: "v", tiers: [{ minQty: 0, unitPrice: 900 }] }).success).toBe(false);
    expect(priceTiersSchema.safeParse({ variantId: "v", tiers: [{ minQty: 1, unitPrice: 1.5 }] }).success).toBe(false);
    expect(quoteActionSchema.safeParse({ action: "reject" }).success).toBe(true);
    expect(quoteActionSchema.safeParse({ action: "reject", items: [] }).success).toBe(false);
    expect(quoteActionSchema.safeParse({ action: "quote", items: [] }).success).toBe(false);
    expect(quoteActionSchema.safeParse({ action: "approve" }).success).toBe(false);
  });
});

/** Ratchet for the wholesale acceptance criterion: every /api/business handler is behind a customer session, and everything but apply/account also behind an approved account. */
describe("business routes", () => {
  const ROOT = "src/app/api/business";
  const CUSTOMER_ONLY = new Set(["apply/route.ts", "account/route.ts"]);
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "route.ts" ? [path.join(d, e.name)] : []));
  const files = walk(ROOT);
  const handlers = (src: string) => {
    const found = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    return found.map((m, i) => ({ method: m[1], body: src.slice(m.index!, found[i + 1]?.index ?? src.length) }));
  };
  it("finds the routes", () => expect(files.length).toBeGreaterThanOrEqual(9));
  it.each(files)("%s is gated", (f) => {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    for (const h of handlers(fs.readFileSync(f, "utf8"))) {
      if (CUSTOMER_ONLY.has(rel)) expect(h.body, `${rel} ${h.method}`).toMatch(/requireCustomer\(\s*req/);
      else expect(h.body, `${rel} ${h.method} must call requireBusiness`).toMatch(/requireBusiness\(\s*req/);
    }
  });
  it("no business route takes the account or customer id from the request", () => {
    for (const f of files) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/searchParams\.get\(["'](businessAccountId|accountId|customerId)|body\.(businessAccountId|accountId|customerId)|parsed\.data\.(businessAccountId|accountId|customerId)/);
  });
  it("retail routes never import wholesale code (no leakage path)", () => {
    for (const f of ["src/app/api/orders/route.ts", "src/app/api/cart/validate/route.ts", "src/app/api/products/route.ts", "src/lib/catalog.ts"]) {
      if (fs.existsSync(f)) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/@\/lib\/wholesale|priceListItem|variantWholesale/);
    }
  });
});
