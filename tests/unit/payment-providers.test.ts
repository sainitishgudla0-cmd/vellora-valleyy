import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentProvider as PaymentProviderEnum, PaymentMode as PaymentModeEnum } from "@prisma/client";
import { PAYMENT_MODES, resolvePaymentConfig, type PaymentConfig } from "@/lib/env/payment-config";
import { providerForConfig, ProviderUnavailableError } from "@/lib/payments/providers";
import { createRequestOnlyProvider } from "@/lib/payments/providers/request-only";
import { MOCK_LABEL, createMockProvider, mockProof } from "@/lib/payments/providers/mock";
import { createRazorpayProvider, verifyRazorpaySignatureWith } from "@/lib/payments/providers/razorpay";
import { recordPaymentAttempt } from "@/lib/payments/records";

const REQ = { orderNumber: "VV-1", amountPaise: 105000, currency: "INR" as const };
const TEST_KEYS = { RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "fake_secret_for_tests" };
const cfg = (env: Record<string, string>): PaymentConfig => resolvePaymentConfig({ NODE_ENV: "test", ...env } as NodeJS.ProcessEnv);
const sign = (secret: string, o: string, p: string) => crypto.createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");

afterEach(() => vi.unstubAllGlobals());

describe("enums match the configuration contract", () => {
  it("PaymentMode enum = PAYMENT_MODES; PaymentProvider enum is the three providers", () => {
    expect(Object.values(PaymentModeEnum).sort()).toEqual([...PAYMENT_MODES].sort());
    expect(Object.values(PaymentProviderEnum).sort()).toEqual(["mock", "razorpay", "request_only"]);
  });
});

describe("request-only provider", () => {
  const p = createRequestOnlyProvider();
  it("takes no payment at order time", async () => {
    expect(p).toMatchObject({ id: "request_only", mode: "request_only", online: false, label: null });
    expect(await p.createPayment(REQ)).toBeNull();
  });
  it("can never verify a payment, whatever proof it is given (no automatic offline confirmation)", () => {
    expect(p.verifyPayment({ providerOrderId: "o", providerPaymentId: "p", signature: sign("x", "o", "p") })).toBe(false);
    expect(p.verifyPayment({ providerOrderId: "", providerPaymentId: "", signature: "" })).toBe(false);
    expect(p.verifyPayment(mockProof("mock_order_VV-1"))).toBe(false);
  });
});

describe("mock provider", () => {
  const p = createMockProvider({ mode: "mock", appEnv: "test" });
  it("is labelled and creates a mock payment without network access", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network used"); }));
    expect(p).toMatchObject({ id: "mock", mode: "mock", online: true, label: MOCK_LABEL });
    const out = await p.createPayment(REQ);
    expect(out).toMatchObject({ providerOrderId: "mock_order_VV-1", amountPaise: 105000, currency: "INR" });
    expect(out!.clientPayload).toMatchObject({ provider: "mock", mock: true });
  });
  it("verifies only its own proofs", () => {
    const good = mockProof("mock_order_VV-1");
    expect(p.verifyPayment(good)).toBe(true);
    expect(p.verifyPayment({ ...good, signature: "0".repeat(64) })).toBe(false);
    expect(p.verifyPayment({ ...good, signature: "short" })).toBe(false);
    expect(p.verifyPayment({ ...good, providerOrderId: "mock_order_VV-2" })).toBe(false);
    expect(p.verifyPayment({ ...good, signature: undefined as unknown as string })).toBe(false);
  });
  it.each(["preview", "production"] as const)("cannot be constructed when APP_ENV=%s", (appEnv) => {
    expect(() => createMockProvider({ mode: "mock", appEnv })).toThrow(ProviderUnavailableError);
  });
  it.each(["request_only", "razorpay_test", "razorpay_live"] as const)("cannot be constructed under PAYMENT_MODE=%s", (mode) => {
    expect(() => createMockProvider({ mode, appEnv: "test" })).toThrow(ProviderUnavailableError);
  });
  it("PAYMENT_MODE=mock is rejected by configuration in preview and production", () => {
    expect(() => cfg({ APP_ENV: "preview", VERCEL_ENV: "preview", PAYMENT_MODE: "mock" })).toThrow();
    expect(() => cfg({ APP_ENV: "production", VERCEL_ENV: "production", PAYMENT_MODE: "mock" })).toThrow();
  });
});

describe("razorpay provider", () => {
  const config = cfg({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS });
  it("creates a Razorpay order via the Orders API and returns the existing checkout payload shape", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "order_RP1", amount: 105000, currency: "INR" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = createRazorpayProvider(config);
    expect(p).toMatchObject({ id: "razorpay", mode: "razorpay_test", online: true, label: null });
    const out = await p.createPayment(REQ);
    expect(out).toMatchObject({ providerOrderId: "order_RP1", amountPaise: 105000 });
    expect(out!.clientPayload).toEqual({ provider: "razorpay", keyId: "rzp_test_abc123", orderId: "order_RP1", amount: 105000, currency: "INR" });
    expect(JSON.stringify(out)).not.toContain(TEST_KEYS.RAZORPAY_KEY_SECRET);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init.body).toBe(JSON.stringify({ amount: 105000, currency: "INR", receipt: "VV-1" }));
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("rzp_test_abc123:fake_secret_for_tests").toString("base64"));
  });
  it("surfaces gateway failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(createRazorpayProvider(config).createPayment(REQ)).rejects.toThrow("Razorpay order creation failed (500)");
  });
  it("verifies signatures in constant time and rejects tampering", () => {
    const p = createRazorpayProvider(config);
    const sig = sign(TEST_KEYS.RAZORPAY_KEY_SECRET, "order_RP1", "pay_1");
    expect(p.verifyPayment({ providerOrderId: "order_RP1", providerPaymentId: "pay_1", signature: sig })).toBe(true);
    expect(p.verifyPayment({ providerOrderId: "order_RP1", providerPaymentId: "pay_2", signature: sig })).toBe(false);
    expect(p.verifyPayment({ providerOrderId: "order_RP1", providerPaymentId: "pay_1", signature: sig.slice(1) })).toBe(false);
    expect(p.verifyPayment({ providerOrderId: "order_RP1", providerPaymentId: "pay_1", signature: "" })).toBe(false);
    expect(verifyRazorpaySignatureWith("other_secret", "order_RP1", "pay_1", sig)).toBe(false);
  });
  it.each([{ mode: "mock" as const, razorpay: null }, { mode: "request_only" as const, razorpay: null }, { mode: "razorpay_test" as const, razorpay: null }])("refuses an unusable config %j", (c) => {
    expect(() => createRazorpayProvider(c)).toThrow(ProviderUnavailableError);
  });
});

describe("providerForConfig", () => {
  it("selects by mode", () => {
    expect(providerForConfig(cfg({ APP_ENV: "test", PAYMENT_MODE: "mock" })).id).toBe("mock");
    expect(providerForConfig(cfg({ APP_ENV: "test", PAYMENT_MODE: "request_only" })).id).toBe("request_only");
    expect(providerForConfig(cfg({ APP_ENV: "test" })).id).toBe("request_only"); // unset → request-only
    expect(providerForConfig(cfg({ APP_ENV: "test", PAYMENT_MODE: "razorpay_test", ...TEST_KEYS })).id).toBe("razorpay");
  });
  it("keys without a mode never enable online payment", () => {
    const p = providerForConfig(cfg({ APP_ENV: "test", ...TEST_KEYS }));
    expect(p).toMatchObject({ id: "request_only", online: false });
  });
});

describe("recordPaymentAttempt", () => {
  const client = () => ({ payment: { create: vi.fn(async ({ data }: { data: object }) => ({ id: "pay1", ...data })) } });
  it("stores provider, mode, amount in paise and an unpaid status", async () => {
    const c = client();
    await recordPaymentAttempt({ id: "mock", mode: "mock" }, "o1", { providerOrderId: "mock_order_VV-1", amountPaise: 105000, currency: "INR" }, c as never);
    expect(c.payment.create).toHaveBeenCalledWith({ data: { orderId: "o1", provider: "mock", mode: "mock", providerOrderId: "mock_order_VV-1", amount: 105000, currency: "INR", status: "unpaid" } });
  });
  it.each([0, -5, 10.5, NaN])("rejects amount %s", (amountPaise) => {
    expect(() => recordPaymentAttempt({ id: "mock", mode: "mock" }, "o1", { providerOrderId: "x", amountPaise, currency: "INR" }, client() as never)).toThrow(RangeError);
  });
});
