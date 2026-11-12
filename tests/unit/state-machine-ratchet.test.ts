/**
 * Ratchet for the roadmap AC "no code writes Order.status / paymentStatus outside the state machine".
 * Direct order writers that predate M2-T2 are pinned here with exact counts. M2-T5/T6 move them onto
 * `transitionOrder` and must lower these numbers; adding a new writer (or a new write in an existing
 * file) fails this test.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LEGACY_WRITERS: Record<string, number> = {
  "src/app/api/admin/orders/[id]/route.ts": 1, // → M2-T6
  "src/app/api/orders/route.ts": 2, // razorpayOrderId attach + cancel-on-gateway-failure → M2-T5
  "src/app/api/payments/razorpay/verify/route.ts": 1, // → M2-T5
};
const ALLOWED = new Set(["src/lib/orders/state-machine.ts"]);
const WRITE = /\b(?:db|tx|prisma)\.order\.(?:update|updateMany|upsert)\s*\(|\$executeRaw[A-Za-z]*[^;]*"Order"/g;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe("direct Order writers", () => {
  const found: Record<string, number> = {};
  for (const f of [...walk("src"), ...walk("scripts")]) {
    const rel = f.split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;
    const n = (fs.readFileSync(f, "utf8").match(WRITE) ?? []).length;
    if (n) found[rel] = n;
  }

  it("matches the pinned legacy list exactly (no new writers; lower the numbers as they migrate)", () => {
    expect(found).toEqual(LEGACY_WRITERS);
  });
});
