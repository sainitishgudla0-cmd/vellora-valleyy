import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOrderPaymentMode } from "@/lib/orders/payment-mode";
import { MOCK_CONFIRM_HEADER, mockConfirmKeyConfigured, mockConfirmKeyValid } from "@/lib/payments/mock-auth";
import { confirmMockPayment } from "@/lib/payments/mock-confirm";
import { MOCK_PAYMENT_LABEL } from "@/lib/payments/labels";
import { PAYMENT_MODES } from "@/lib/env/payment-config";

const dbMock = vi.hoisted(() => ({ order: { findUnique: vi.fn() }, payment: { findFirst: vi.fn() }, $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const KEY = "unit-test-confirm-key-0123456789";
afterEach(() => vi.clearAllMocks());

describe("resolveOrderPaymentMode (server-resolved, never client-supplied)", () => {
  it("pay-on-delivery is always request_only, whatever the global mode", () => {
    for (const mode of PAYMENT_MODES) expect(resolveOrderPaymentMode("cod", { mode })).toBe("request_only");
    expect(resolveOrderPaymentMode("cod", null)).toBe("request_only");
  });
  it("online orders take the configured online mode", () => {
    expect(resolveOrderPaymentMode("razorpay", { mode: "mock" })).toBe("mock");
    expect(resolveOrderPaymentMode("razorpay", { mode: "razorpay_test" })).toBe("razorpay_test");
    expect(resolveOrderPaymentMode("razorpay", { mode: "razorpay_live" })).toBe("razorpay_live");
  });
  it("online orders have no consistent mode when online payments are off or config is invalid", () => {
    expect(resolveOrderPaymentMode("razorpay", { mode: "request_only" })).toBeNull();
    expect(resolveOrderPaymentMode("razorpay", null)).toBeNull();
  });
});

describe("mock confirm key", () => {
  it("is absent unless 24+ characters", () => {
    expect(mockConfirmKeyConfigured({ MOCK_PAYMENT_CONFIRM_KEY: "short" } as never)).toBe(false);
    expect(mockConfirmKeyConfigured({} as never)).toBe(false);
    expect(mockConfirmKeyConfigured({ MOCK_PAYMENT_CONFIRM_KEY: KEY } as never)).toBe(true);
  });
  it("compares exactly and rejects missing/short/different values", () => {
    const env = { MOCK_PAYMENT_CONFIRM_KEY: KEY } as never;
    expect(mockConfirmKeyValid(KEY, env)).toBe(true);
    expect(mockConfirmKeyValid(KEY + "x", env)).toBe(false);
    expect(mockConfirmKeyValid("", env)).toBe(false);
    expect(mockConfirmKeyValid(null, env)).toBe(false);
    expect(mockConfirmKeyValid("short", { MOCK_PAYMENT_CONFIRM_KEY: "short" } as never)).toBe(false);
    expect(MOCK_CONFIRM_HEADER).toBe("x-mock-confirm-key");
  });
});

describe("confirmMockPayment environment barrier", () => {
  const input = { orderNumber: "VV-1", token: "t", providerOrderId: "mock_order_VV-1", providerPaymentId: "mock_pay_VV-1", signature: "s" };
  it.each([
    [{ mode: "mock", appEnv: "preview" }],
    [{ mode: "mock", appEnv: "production" }],
    [{ mode: "request_only", appEnv: "test" }],
    [{ mode: "razorpay_test", appEnv: "test" }],
  ] as const)("refuses %j before touching the database", async (cfg) => {
    await expect(confirmMockPayment(input, cfg)).rejects.toThrow();
    expect(dbMock.order.findUnique).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
  it("unknown order → not_found without any write", async () => {
    dbMock.order.findUnique.mockResolvedValue(null);
    expect(await confirmMockPayment(input, { mode: "mock", appEnv: "test" })).toEqual({ kind: "not_found" });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
});

it("label text is exactly the authorised copy", () => {
  expect(MOCK_PAYMENT_LABEL).toBe("MOCK — no money moved");
});
