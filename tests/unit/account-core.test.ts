import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OtpConfigError, resolveOtpConfig } from "@/lib/env/otp-config";
import { addressCreateSchema, addressPatchSchema, claimSchema, consentSchema, deleteAccountSchema, otpRequestSchema, otpVerifySchema, profilePatchSchema } from "@/lib/account/schemas";

describe("customer OTP configuration (fails closed)", () => {
  const cfg = (env: Record<string, string>) => resolveOtpConfig(env);
  it("is off by default and warns outside development/test", () => {
    expect(cfg({ APP_ENV: "development" })).toMatchObject({ mode: "off", warnings: [] });
    expect(cfg({ APP_ENV: "production" }).warnings.join()).toMatch(/disabled until a real OTP sender/);
  });
  it.each(["development", "test"])("allows the mock sender in %s", (appEnv) => {
    expect(cfg({ APP_ENV: appEnv, CUSTOMER_OTP_MODE: "mock" }).mode).toBe("mock");
  });
  it.each(["preview", "production"])("refuses the mock sender in %s", (appEnv) => {
    expect(() => cfg({ APP_ENV: appEnv, CUSTOMER_OTP_MODE: "mock" })).toThrow(OtpConfigError);
  });
  it("refuses unknown modes", () => {
    expect(() => cfg({ APP_ENV: "development", CUSTOMER_OTP_MODE: "sms" })).toThrow(/not one of/);
  });
});

describe("account request schemas are strict", () => {
  const ok = { name: "Asha Rao", phone: "9876543210", line1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" };
  it("rejects unknown fields instead of ignoring them (no mass assignment of customerId etc.)", () => {
    expect(otpRequestSchema.safeParse({ email: "a@example.com", customerId: "x" }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ name: "Asha Rao", email: "other@example.com" }).success).toBe(false);
    expect(addressCreateSchema.safeParse({ ...ok, customerId: "someone-else" }).success).toBe(false);
    expect(consentSchema.safeParse({ marketing: true, version: "x" }).success).toBe(false);
  });
  it("validates codes, addresses, claims and the deletion confirmation", () => {
    expect(otpVerifySchema.safeParse({ email: "A@Example.com", code: "123456" })).toMatchObject({ success: true, data: { email: "a@example.com" } });
    for (const code of ["12345", "1234567", "abcdef", "12 456", ""]) expect(otpVerifySchema.safeParse({ email: "a@example.com", code }).success).toBe(false);
    expect(addressCreateSchema.safeParse(ok).success).toBe(true);
    expect(addressCreateSchema.safeParse({ ...ok, pincode: "012345" }).success).toBe(false);
    expect(addressCreateSchema.safeParse({ ...ok, state: "Atlantis" }).success).toBe(false);
    expect(addressCreateSchema.safeParse({ ...ok, phone: "12345" }).success).toBe(false);
    expect(addressPatchSchema.safeParse({}).success).toBe(false);
    expect(addressPatchSchema.safeParse({ city: "Hyderabad" }).success).toBe(true);
    expect(claimSchema.safeParse({ mode: "email" }).success).toBe(true);
    expect(claimSchema.safeParse({ orderNumber: "VV-1", token: "t" }).success).toBe(true);
    expect(claimSchema.safeParse({ mode: "email", orderNumber: "VV-1" }).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ confirm: "DELETE" }).success).toBe(true);
    expect(deleteAccountSchema.safeParse({ confirm: "yes" }).success).toBe(false);
  });
});

/**
 * Ratchet for the M5 acceptance criterion "all account routes covered by authz tests": every /api/account handler
 * calls requireCustomer, except sign-in (otp/*) and logout, which use the same-origin check and have no session to require.
 */
describe("account routes", () => {
  const ROOT = "src/app/api/account";
  const PRE_SESSION = new Set(["otp/request/route.ts", "otp/verify/route.ts", "logout/route.ts"]);
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "route.ts" ? [path.join(d, e.name)] : []));
  const files = walk(ROOT);
  const handlers = (src: string) => {
    const found = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    return found.map((m, i) => ({ method: m[1], body: src.slice(m.index!, found[i + 1]?.index ?? src.length) }));
  };
  it("finds the routes", () => expect(files.length).toBeGreaterThanOrEqual(11));
  it.each(files)("%s is gated", (f) => {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    const hs = handlers(fs.readFileSync(f, "utf8"));
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) {
      if (PRE_SESSION.has(rel)) expect(h.body, `${rel} ${h.method}`).toContain("requireCustomerSameOrigin(");
      else expect(h.body, `${rel} ${h.method} must call requireCustomer`).toMatch(/requireCustomer\(\s*req/);
    }
  });
  it("no account route takes a customer id from the request", () => {
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/searchParams\.get\(["']customerId|body\.customerId|parsed\.data\.customerId/);
    }
  });
});
