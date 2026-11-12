import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { currentPaymentProvider, onlinePaymentsEnabled, verifyRazorpaySignature } from "@/lib/payments";

afterEach(() => vi.unstubAllEnvs());
const env = (e: Record<string, string>) => Object.entries({ APP_ENV: "test", VERCEL_ENV: "", ...e }).forEach(([k, v]) => vi.stubEnv(k, v));

describe("payments.ts facade", () => {
  it("defaults to the request-only provider, with online payments off", () => {
    env({});
    vi.stubEnv("PAYMENT_MODE", "");
    expect(currentPaymentProvider()?.id).toBe("request_only");
    expect(onlinePaymentsEnabled()).toBe(false);
    expect(verifyRazorpaySignature("o", "p", "sig")).toBe(false);
  });
  it("uses Razorpay in razorpay_test and verifies via the same HMAC as before", () => {
    env({ PAYMENT_MODE: "razorpay_test", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "fake_secret" });
    expect(currentPaymentProvider()?.id).toBe("razorpay");
    const sig = crypto.createHmac("sha256", "fake_secret").update("o|p").digest("hex");
    expect(verifyRazorpaySignature("o", "p", sig)).toBe(true);
    expect(verifyRazorpaySignature("o", "p", sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"))).toBe(false);
  });
  it("fails closed (no provider) on an invalid configuration", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env({ PAYMENT_MODE: "mock", APP_ENV: "preview", VERCEL_ENV: "preview" });
    expect(currentPaymentProvider()).toBeNull();
    expect(onlinePaymentsEnabled()).toBe(false);
  });
});
