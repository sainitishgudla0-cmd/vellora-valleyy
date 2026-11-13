import { afterEach, describe, expect, it, vi } from "vitest";
import { errorName, log, sanitizeFields, setLogSink, type LogRecord } from "@/lib/log";
import { onRequestError } from "@/instrumentation";

const records: LogRecord[] = [];
const capture = () => {
  records.length = 0;
  setLogSink((r) => records.push(r));
};
afterEach(() => setLogSink(null));

describe("structured logger (M9-T5)", () => {
  it("emits one record with the fixed keys and the given fields", () => {
    capture();
    log.error("payments.verify_conflict", { order: "VV-1", reason: "amount_mismatch" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: "error", event: "payments.verify_conflict", service: "velora-valley", order: "VV-1", reason: "amount_mismatch" });
    expect(new Date(records[0].ts).toString()).not.toBe("Invalid Date");
  });

  it("a field can never overwrite the fixed keys", () => {
    capture();
    log.info("real.event", { event: "spoofed", level: "debug", service: "x" } as never);
    expect(records[0]).toMatchObject({ event: "real.event", level: "info", service: "velora-valley" });
  });

  it.each(["password", "adminPassword", "token", "accessToken", "authorization", "cookie", "signature", "razorpay_signature", "otp", "otpCode", "code", "email", "customerEmail", "phone", "addressLine1", "customerName", "pincode", "gstin", "apiKey", "sessionToken", "tokenHash", "body", "payload", "cardNumber", "upiId", "accountNumber"])("redacts a field called %s", (name) => {
    expect(sanitizeFields({ [name]: "sensitive-value-123" })[name]).toBe("[redacted]");
  });

  it("keeps safe identifiers and reason codes", () => {
    const f = sanitizeFields({ order: "VV-1", reason: "no_stock", errorName: "TypeError", errorCode: "P2002", statusCode: 409, count: 3, ok: false, none: null });
    expect(f).toEqual({ order: "VV-1", reason: "no_stock", errorName: "TypeError", errorCode: "P2002", statusCode: 409, count: 3, ok: false, none: null });
  });

  it("truncates long strings and drops undefined", () => {
    const f = sanitizeFields({ detail: "x".repeat(500), gone: undefined });
    expect((f.detail as string).length).toBeLessThanOrEqual(201);
    expect("gone" in f).toBe(false);
  });

  it("errorName never returns a message", () => {
    expect(errorName(new TypeError("secret customer data"))).toBe("TypeError");
    expect(errorName("a string with secrets")).toBe("string");
  });

  it("writes JSON lines to the console at the right level, and is quiet under test unless LOG_LEVEL is set", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    log.error("quiet.in.test");
    expect(err).not.toHaveBeenCalled();
    vi.stubEnv("LOG_LEVEL", "info");
    log.error("loud.error", { order: "VV-2" });
    log.info("loud.info");
    expect(JSON.parse(err.mock.calls[0][0] as string)).toMatchObject({ event: "loud.error", order: "VV-2", level: "error" });
    expect(JSON.parse(out.mock.calls[0][0] as string)).toMatchObject({ event: "loud.info", level: "info" });
    log.debug("below.threshold");
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("log.dev prints only in development", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const [vercel, app] of [["production", ""], ["preview", ""], ["", "test"]]) {
      vi.stubEnv("VERCEL_ENV", vercel);
      vi.stubEnv("APP_ENV", app);
      log.dev("code 123456");
    }
    expect(info).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("APP_ENV", "development");
    log.dev("code 123456");
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("onRequestError hook", () => {
  it("logs the class name, digest and route, never the message or the query string", async () => {
    capture();
    const err = Object.assign(new RangeError("customer@example.com failed"), { digest: "abc123" });
    await onRequestError(err, { path: "/order/VV-1?t=SECRET-ACCESS-TOKEN", method: "GET", headers: {} }, { routerKind: "App Router", routePath: "/order/[number]", routeType: "render", renderSource: "react-server-components", revalidateReason: undefined, renderType: "dynamic" } as never);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "request.unhandled_error", errorName: "RangeError", digest: "abc123", path: "/order/VV-1", routePath: "/order/[number]" });
    expect(JSON.stringify(records[0])).not.toMatch(/SECRET|example\.com/);
  });
});
