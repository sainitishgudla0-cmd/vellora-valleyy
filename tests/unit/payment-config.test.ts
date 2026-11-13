import { describe, expect, it } from "vitest";
import { PaymentConfigError, resolvePaymentConfig } from "@/lib/env/payment-config";

const TEST_KEYS = { RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "test_secret" };
const LIVE_KEYS = { RAZORPAY_KEY_ID: "rzp_live_abc123", RAZORPAY_KEY_SECRET: "live_secret", RAZORPAY_WEBHOOK_SECRET: "whsec_live_0123456789" };

const issuesOf = (env: Record<string, string>) => {
  try {
    resolvePaymentConfig(env);
  } catch (e) {
    if (e instanceof PaymentConfigError) return e.issues.join(" ");
    throw e;
  }
  throw new Error("expected PaymentConfigError");
};

describe("resolvePaymentConfig — permitted combinations", () => {
  it("defaults to request_only with online payments off", () => {
    const c = resolvePaymentConfig({ VERCEL_ENV: "production" });
    expect(c).toMatchObject({ mode: "request_only", appEnv: "production", onlinePayments: false, razorpay: null, warnings: [] });
  });

  it("ignores Razorpay keys (with a warning) when PAYMENT_MODE is unset — keeps current safe checkout", () => {
    const c = resolvePaymentConfig({ VERCEL_ENV: "production", ...LIVE_KEYS });
    expect(c.onlinePayments).toBe(false);
    expect(c.razorpay).toBeNull();
    expect(c.warnings[0]).toMatch(/ignored/);
  });

  it.each(["development", "test", "preview", "production"])("request_only is allowed in %s", (appEnv) => {
    const env = appEnv === "preview" || appEnv === "production" ? { VERCEL_ENV: appEnv } : { APP_ENV: appEnv };
    expect(resolvePaymentConfig({ ...env, PAYMENT_MODE: "request_only" }).onlinePayments).toBe(false);
  });

  it.each(["development", "test"])("mock is allowed in %s and never enables a gateway", (appEnv) => {
    const c = resolvePaymentConfig({ APP_ENV: appEnv, PAYMENT_MODE: "mock", ...TEST_KEYS });
    expect(c).toMatchObject({ mode: "mock", onlinePayments: false, razorpay: null });
  });

  it("razorpay_test with test keys is allowed in development and preview", () => {
    expect(resolvePaymentConfig({ APP_ENV: "development", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS }).razorpay).toEqual({
      keyId: "rzp_test_abc123",
      keySecret: "test_secret",
      webhookSecret: null,
    });
    expect(resolvePaymentConfig({ VERCEL_ENV: "preview", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS }).onlinePayments).toBe(true);
  });

  it("razorpay_live is allowed only in production with live keys and the explicit launch switch", () => {
    const c = resolvePaymentConfig({ VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS });
    expect(c).toMatchObject({ mode: "razorpay_live", onlinePayments: true });
  });
});

describe("resolvePaymentConfig — rejected combinations", () => {
  it.each([
    ["mock in production", { VERCEL_ENV: "production", PAYMENT_MODE: "mock" }, /mock is not allowed/],
    ["mock in preview", { VERCEL_ENV: "preview", PAYMENT_MODE: "mock" }, /mock is not allowed/],
    ["mock in an unlabelled production build", { NODE_ENV: "production", PAYMENT_MODE: "mock" }, /mock is not allowed/],
    ["razorpay_test in production", { VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS }, /razorpay_test is not allowed/],
    ["razorpay_test without keys", { APP_ENV: "development", PAYMENT_MODE: "razorpay_test" }, /requires RAZORPAY_KEY_ID/],
    ["razorpay_test with live keys", { APP_ENV: "development", PAYMENT_MODE: "razorpay_test", ...LIVE_KEYS }, /Live Razorpay keys must never/],
    ["razorpay_live in preview", { VERCEL_ENV: "preview", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS }, /razorpay_live is not allowed/],
    ["razorpay_live in development", { APP_ENV: "development", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS }, /Live Razorpay keys must never/],
    ["razorpay_live with test keys", { VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...TEST_KEYS }, /starting with "rzp_live_"/],
    ["razorpay_live without the launch switch", { VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", ...LIVE_KEYS }, /RAZORPAY_LIVE_ENABLED=true/],
    ["live keys in development even in request_only", { APP_ENV: "development", PAYMENT_MODE: "request_only", ...LIVE_KEYS }, /Live Razorpay keys must never/],
    ["unknown mode", { APP_ENV: "development", PAYMENT_MODE: "stripe" }, /not one of/],
    ["contradictory APP_ENV", { VERCEL_ENV: "production", APP_ENV: "test", PAYMENT_MODE: "mock" }, /contradicts/],
  ] as const)("%s", (_name, env, pattern) => {
    expect(issuesOf(env as Record<string, string>)).toMatch(pattern);
  });
});

describe("MOCK_PAYMENT_CONFIRM_KEY (mock-only credential)", () => {
  const KEY = { MOCK_PAYMENT_CONFIRM_KEY: "unit-test-confirm-key-0123456789" };
  it.each(["preview", "production"])("is rejected when APP_ENV=%s, in every mode", (appEnv) => {
    for (const PAYMENT_MODE of ["request_only", "razorpay_test", "razorpay_live", "mock"]) {
      expect(() => resolvePaymentConfig({ VERCEL_ENV: appEnv, PAYMENT_MODE, RAZORPAY_LIVE_ENABLED: "true", ...(PAYMENT_MODE === "razorpay_live" ? LIVE_KEYS : TEST_KEYS), ...KEY })).toThrow(PaymentConfigError);
    }
    expect(issuesOf({ VERCEL_ENV: appEnv, ...KEY })).toMatch(/MOCK_PAYMENT_CONFIRM_KEY must not be set/);
  });
  it("is allowed in development/test with mock, and warns (no effect) with other modes", () => {
    expect(resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "mock", ...KEY }).warnings).toEqual([]);
    expect(resolvePaymentConfig({ APP_ENV: "development", PAYMENT_MODE: "request_only", ...KEY }).warnings[0]).toMatch(/no effect/);
  });
  it("an empty value is treated as unset (production default env stays valid)", () => {
    expect(resolvePaymentConfig({ VERCEL_ENV: "production", MOCK_PAYMENT_CONFIRM_KEY: "" }).mode).toBe("request_only");
  });
  it("checkout needs no mock key: production request_only and razorpay_live resolve without it", () => {
    expect(resolvePaymentConfig({ VERCEL_ENV: "production" }).mode).toBe("request_only");
    expect(resolvePaymentConfig({ VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS }).mode).toBe("razorpay_live");
  });
});

describe("RAZORPAY_WEBHOOK_SECRET (M10)", () => {
  const SECRET = "whsec_0123456789abcdef";
  it("is optional in razorpay_test (warns, webhook disabled) and carried into the config when set", () => {
    const without = resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS });
    expect(without.razorpay?.webhookSecret).toBeNull();
    expect(without.warnings.join(" ")).toMatch(/WEBHOOK_SECRET is not set/);
    const withSecret = resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS, RAZORPAY_WEBHOOK_SECRET: ` ${SECRET} ` });
    expect(withSecret.razorpay).toEqual({ keyId: "rzp_test_abc123", keySecret: "test_secret", webhookSecret: SECRET });
    expect(withSecret.warnings).toEqual([]);
  });
  it("is required for razorpay_live (webhooks are the source of truth at launch)", () => {
    expect(issuesOf({ VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS, RAZORPAY_WEBHOOK_SECRET: "" })).toMatch(/requires RAZORPAY_WEBHOOK_SECRET/);
    const ok = resolvePaymentConfig({ VERCEL_ENV: "production", PAYMENT_MODE: "razorpay_live", RAZORPAY_LIVE_ENABLED: "true", ...LIVE_KEYS, RAZORPAY_WEBHOOK_SECRET: SECRET });
    expect(ok.razorpay?.webhookSecret).toBe(SECRET);
  });
  it("must be at least 16 characters when set, in any Razorpay mode", () => {
    expect(issuesOf({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS, RAZORPAY_WEBHOOK_SECRET: "short" })).toMatch(/at least 16/);
  });
  it("is ignored with a warning outside Razorpay modes and never reaches the config", () => {
    const c = resolvePaymentConfig({ APP_ENV: "test", PAYMENT_MODE: "mock", RAZORPAY_WEBHOOK_SECRET: SECRET });
    expect(c.razorpay).toBeNull();
    expect(c.warnings.join(" ")).toMatch(/no effect/);
  });
});
