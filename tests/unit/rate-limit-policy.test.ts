/**
 * M11 P1-T6 (F08): every limiter bucket used by a route has an explicit fail mode, sensitive buckets fail closed, an
 * unlisted bucket fails closed, and per-instance counters are refused in deployed environments.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { failModeFor, RATE_LIMIT_POLICY } from "@/lib/rate-limit";
import { checkSecurityConfig } from "@/lib/env/security-config";

const root = path.resolve(__dirname, "../..");
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}
const usedBuckets = [...new Set(files(path.join(root, "src/app")).flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/rateLimit\("([^"]+)"/g)].map((m) => m[1])))].sort();

describe("rate-limit fail-mode policy", () => {
  it("every bucket used under src/app is listed explicitly, and nothing listed is unused", () => {
    expect(usedBuckets.length).toBeGreaterThan(10);
    expect(Object.keys(RATE_LIMIT_POLICY).sort()).toEqual(usedBuckets);
  });

  it("credential, one-time-code, payment, order and wholesale-write buckets fail closed", () => {
    for (const b of ["admin-login", "admin-password", "account-otp-request", "account-otp-verify", "account-claim", "account-export", "payment-verify", "mock-confirm", "orders", "business-orders", "business-quote", "business-quote-accept", "business-apply"]) {
      expect(failModeFor(b), b).toBe("closed");
    }
  });

  it("only public low-value buckets fail open", () => {
    expect(Object.entries(RATE_LIMIT_POLICY).filter(([, m]) => m === "open").map(([b]) => b).sort()).toEqual(["enquiries", "newsletter", "order-invoice", "shipping-quote"]);
  });

  it("an unlisted bucket fails closed", () => {
    expect(failModeFor("some-new-route")).toBe("closed");
  });
});

describe("env:check security gate", () => {
  it("refuses RATE_LIMIT_STORE=memory in preview and production, allows it in development/test", () => {
    expect(checkSecurityConfig({ VERCEL_ENV: "production", RATE_LIMIT_STORE: "memory" }).ok).toBe(false);
    expect(checkSecurityConfig({ VERCEL_ENV: "preview", RATE_LIMIT_STORE: "memory" }).ok).toBe(false);
    expect(checkSecurityConfig({ APP_ENV: "test", RATE_LIMIT_STORE: "memory" }).ok).toBe(true);
    expect(checkSecurityConfig({ APP_ENV: "development", RATE_LIMIT_STORE: "memory" }).ok).toBe(true);
    expect(checkSecurityConfig({ VERCEL_ENV: "production", CRON_SECRET: "c".repeat(32) }).ok).toBe(true);
  });

  it("refuses an unknown store value everywhere", () => {
    expect(checkSecurityConfig({ APP_ENV: "test", RATE_LIMIT_STORE: "redis" }).ok).toBe(false);
  });
});
