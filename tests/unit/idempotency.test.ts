import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { canonicalJson, hashKey, hashRequest, IDEMPOTENCY_KEY_PATTERN, readIdempotencyKey } from "@/lib/orders/idempotency";

const req = (h?: string) => new Request("http://localhost/api/orders", { method: "POST", headers: h === undefined ? {} : { "Idempotency-Key": h } });

describe("Idempotency-Key header", () => {
  it("is optional", () => expect(readIdempotencyKey(req())).toEqual({ kind: "none" }));
  it("accepts 16-128 URL-safe characters and trims whitespace", () => {
    expect(readIdempotencyKey(req("a".repeat(16)))).toEqual({ kind: "key", key: "a".repeat(16) });
    expect(readIdempotencyKey(req(" 123e4567-e89b-12d3-a456-426614174000 "))).toMatchObject({ kind: "key" });
    expect(readIdempotencyKey(req("A_b-9".repeat(25)))).toMatchObject({ kind: "key" }); // 125 chars
  });
  it.each(["", "short", "a".repeat(129), "has space in the middle 12345", "semi;colon;1234567890", "ünïcode-key-1234567890"])("rejects %j", (bad) => {
    expect(readIdempotencyKey(req(bad))).toEqual({ kind: "invalid" });
    expect(IDEMPOTENCY_KEY_PATTERN.test(bad)).toBe(false);
  });
});

describe("hashing", () => {
  it("hashes keys with a domain prefix and never returns the key", () => {
    const h = hashKey("abcdefghijklmnop");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("abcdefghijklmnop");
    expect(hashKey("abcdefghijklmnop")).toBe(h);
    expect(hashKey("abcdefghijklmnoq")).not.toBe(h);
  });
  it("canonical JSON ignores property order but not values or array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } })).toBe(canonicalJson({ a: { c: "x", d: [1, 2] }, b: 1 }));
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ items: [1, 2] })).not.toBe(hashRequest({ items: [2, 1] }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: "1" }));
  });
  it("treats undefined properties as absent", () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });
});
