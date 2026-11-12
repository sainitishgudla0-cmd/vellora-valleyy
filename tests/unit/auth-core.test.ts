import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, hasPermission, PERMISSIONS, ROLE_PERMISSIONS, type AdminRoleName, type Permission } from "@/lib/auth/roles";
import { allowedOriginsFromEnv, isMutation, isSameOrigin } from "@/lib/auth/origin";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem, verifyPassword } from "@/lib/auth/password";

describe("role × permission matrix", () => {
  // Written out in full on purpose: a change to access rules must change this table.
  const EXPECTED: Record<AdminRoleName, Permission[]> = {
    owner: ["admin:read", "orders:write", "enquiries:write", "variants:write", "catalog:write", "inventory:write", "testdata:write", "users:manage", "wholesale:read", "wholesale:write", "pricing:write"],
    operations: ["admin:read", "orders:write", "enquiries:write", "variants:write", "inventory:write", "wholesale:read", "wholesale:write"],
    catalog: ["admin:read", "variants:write", "catalog:write", "inventory:write", "wholesale:read", "pricing:write"],
    viewer: ["admin:read"],
  };
  it.each(ADMIN_ROLES)("%s has exactly its permissions", (role) => {
    for (const p of PERMISSIONS) expect(hasPermission(role, p), `${role} ${p}`).toBe(EXPECTED[role].includes(p));
    expect([...ROLE_PERMISSIONS[role]].sort()).toEqual([...EXPECTED[role]].sort());
  });
  it("the shared-password (legacy) session never manages users, whatever role it carries", () => {
    expect(hasPermission("owner", "users:manage", true)).toBe(false);
    expect(hasPermission("owner", "orders:write", true)).toBe(true);
  });
  it("an unknown role has no permissions", () => {
    expect(hasPermission("intern" as AdminRoleName, "admin:read")).toBe(false);
  });
});

describe("same-origin check", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("never blocks reads", () => {
    expect(isSameOrigin(h({ origin: "https://evil.example" }), "GET")).toBe(true);
    expect(isMutation("GET")).toBe(false);
    expect(isMutation("delete")).toBe(true);
  });
  it("accepts a matching Origin, using the forwarded host first", () => {
    expect(isSameOrigin(h({ origin: "https://shop.example", host: "shop.example" }), "POST")).toBe(true);
    expect(isSameOrigin(h({ origin: "https://shop.example", host: "internal:3000", "x-forwarded-host": "shop.example" }), "PATCH")).toBe(true);
  });
  it.each([
    [{ origin: "https://evil.example", host: "shop.example" }],
    [{ origin: "null", host: "shop.example" }],
    [{ origin: "not a url", host: "shop.example" }],
    [{ origin: "https://shop.example.evil.example", host: "shop.example" }],
    [{ origin: "https://shop.example" }], // no host to compare with
  ])("rejects %j", (headers) => {
    expect(isSameOrigin(h(headers), "DELETE")).toBe(false);
  });
  it("without Origin: allows non-browser clients, honours Sec-Fetch-Site", () => {
    expect(isSameOrigin(h({}), "POST")).toBe(true);
    expect(isSameOrigin(h({ "sec-fetch-site": "same-origin" }), "POST")).toBe(true);
    expect(isSameOrigin(h({ "sec-fetch-site": "none" }), "POST")).toBe(true);
    expect(isSameOrigin(h({ "sec-fetch-site": "cross-site" }), "POST")).toBe(false);
    expect(isSameOrigin(h({ "sec-fetch-site": "same-site" }), "POST")).toBe(false);
  });
  it("extra allowed origins come from ADMIN_ALLOWED_ORIGINS", () => {
    const extra = allowedOriginsFromEnv({ ADMIN_ALLOWED_ORIGINS: " https://admin.example , ,https://b.example" });
    expect(extra).toEqual(["https://admin.example", "https://b.example"]);
    expect(isSameOrigin(h({ origin: "https://admin.example", host: "shop.example" }), "POST", extra)).toBe(true);
    expect(allowedOriginsFromEnv({})).toEqual([]);
  });
});

describe("passwords", () => {
  it("hashes with scrypt, a random salt, and verifies", async () => {
    const a = await hashPassword("a long enough password");
    const b = await hashPassword("a long enough password");
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("a long enough password");
    expect(await verifyPassword("a long enough password", a)).toBe(true);
    expect(await verifyPassword("A long enough password", a)).toBe(false);
    expect(await verifyPassword("a long enough password", b)).toBe(true);
  });
  it("treats unicode-equivalent passwords as equal (NFKC)", async () => {
    const h = await hashPassword("passéword-long-enough");
    expect(await verifyPassword("passéword-long-enough", h)).toBe(true);
  });
  it.each(["", "plain", "scrypt$1$1$1$a", "bcrypt$x$y$z$a$b", "scrypt$32768$8$1$AAAA$", "scrypt$99999999999$8$1$AAAA$BBBB", "scrypt$abc$8$1$AAAA$BBBB"])("rejects a malformed stored hash %j", async (stored) => {
    expect(await verifyPassword("whatever password", stored)).toBe(false);
  });
  it("policy: length, repetition, and not containing the email name", () => {
    expect(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toMatch(/repetitive/);
    expect(passwordProblem("my-priya.sharma-secret", "priya.sharma@example.com")).toMatch(/email name/);
    expect(passwordProblem("a perfectly fine passphrase", "priya@example.com")).toBeNull();
  });
});
