import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../../config/security-headers.mjs";

const header = (name: string, dev = false) => securityHeaders({ dev }).find((h) => h.key === name)?.value;
const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name} `) || s === name);

describe("security headers (M9-T3)", () => {
  it("sends the full set on every response", () => {
    const keys = securityHeaders().map((h) => h.key);
    for (const k of ["Content-Security-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"]) {
      expect(keys).toContain(k);
    }
  });

  it("forbids framing, plugins and base-tag/form hijacking", () => {
    const csp = contentSecurityPolicy();
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("allows only Razorpay as a third party and nothing over http", () => {
    const csp = contentSecurityPolicy();
    const hosts = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(h).toMatch(/^https:\/\/[a-z]+\.razorpay\.com$/);
    expect(csp).not.toContain("*");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("never allows eval or websockets in production, only in dev", () => {
    expect(contentSecurityPolicy()).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy()).not.toMatch(/\bwss?:/);
    expect(contentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy({ dev: true })).not.toContain("upgrade-insecure-requests");
  });

  it("HSTS is at least a year and does not preload or cover subdomains without a decision", () => {
    const v = header("Strict-Transport-Security") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(v)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(v).not.toMatch(/preload|includeSubDomains/i);
  });

  it("limits referrers and powerful features", () => {
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const pp = header("Permissions-Policy") ?? "";
    for (const f of ["camera=()", "microphone=()", "geolocation=()"]) expect(pp).toContain(f);
    expect(header("X-Content-Type-Options")).toBe("nosniff");
  });
});
