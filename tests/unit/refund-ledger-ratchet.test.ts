/**
 * M10 ratchet: the refund ledger is money. Only the refund service and the reconciliation pass may write `Refund`
 * rows, and only the refund service may talk to the gateway's refund endpoint; no route, webhook handler or script
 * can add a second writer (ADR 0018).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
const files = [...walk("src"), ...walk("scripts")].filter((f) => !/ 2\./.test(f)).map((f) => ({ f: f.split(path.sep).join("/"), src: fs.readFileSync(f, "utf8") }));

describe("refund ledger writers", () => {
  it("only refunds.ts and reconcile.ts write Refund rows", () => {
    const writers = files.filter(({ src }) => /\.refund\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(src)).map((x) => x.f).sort();
    expect(writers).toEqual(["src/lib/payments/reconcile.ts", "src/lib/payments/refunds.ts"]);
  });

  it("nothing outside the refund service calls the gateway's createRefund (its definition aside)", () => {
    const callers = files.filter(({ src }) => /\.createRefund\s*\(/.test(src)).map((x) => x.f);
    expect(callers).toEqual(["src/lib/payments/refunds.ts"]);
  });

  it("the webhook route reads the raw body as text, never req.json() (the signature covers the exact bytes)", () => {
    const route = fs.readFileSync("src/app/api/payments/razorpay/webhook/route.ts", "utf8");
    expect(route).toMatch(/req\.text\(\)/);
    expect(route).not.toMatch(/req\.json\(|parseBody/);
  });
});
