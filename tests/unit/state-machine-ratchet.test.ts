/**
 * Ratchet for the roadmap AC "no code writes Order.status / paymentStatus outside the state machine".
 * Every direct `order.update/updateMany/upsert` call under src/ and scripts/ is found and classified by whether
 * its argument touches `status` or `paymentStatus`:
 *  - status writers: only `src/lib/orders/state-machine.ts` (the implementation) plus the legacy list below;
 *  - non-status writers (e.g. attaching a gateway reference): pinned per file with exact counts.
 * M2-T5 moved checkout and Razorpay verification, and M2-T6 the admin PATCH, onto `transitionOrder`: the legacy
 * status-writer list is empty and must stay empty.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LEGACY_STATUS_WRITERS: Record<string, number> = {}; // M2-T6 moved the admin PATCH onto the state machine: nothing is left
const NON_STATUS_WRITERS: Record<string, number> = {
  "src/lib/payments/checkout.ts": 1, // attaches Order.razorpayOrderId after the gateway call
  "src/lib/payments/reconcile.ts": 1, // same, for a lost create response
  "src/lib/account/claim.ts": 2, // links a guest order to a verified customer (customerId only)
  "src/lib/account/erasure.ts": 1, // anonymises an erased customer's orders (personal fields only)
};
const IMPLEMENTATION = new Set(["src/lib/orders/state-machine.ts"]);
const START = /\b(?:db|tx|prisma)\.order\.(?:update|updateMany|upsert)\s*\(|\$executeRaw[A-Za-z]*\s*[`(]/g;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

/** The text of a call from its opening parenthesis/backtick to the matching close. */
function callText(src: string, openIdx: number): string {
  const open = src[openIdx];
  if (open === "`") return src.slice(openIdx, src.indexOf("`", openIdx + 1) + 1);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

/**
 * True when the call may write status fields: its `data` is not an object literal (unknown contents, e.g.
 * `data: parsed.data`), or the literal mentions status/paymentStatus. `where` clauses are ignored on purpose.
 */
export function writesStatus(call: string): boolean {
  const m = /\bdata\s*:\s*/.exec(call);
  if (!m) return /"Order"/.test(call); // raw SQL
  const rest = call.slice(m.index + m[0].length);
  if (rest[0] !== "{") return true;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}" && --depth === 0) return /\b(?:paymentStatus|status)\b/.test(rest.slice(0, i + 1));
  }
  return true;
}

function scan() {
  const status: Record<string, number> = {};
  const other: Record<string, number> = {};
  for (const f of [...walk("src"), ...walk("scripts")]) {
    const rel = f.split(path.sep).join("/");
    if (IMPLEMENTATION.has(rel)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(START)) {
      const text = callText(src, m.index! + m[0].length - 1);
      const bucket = writesStatus(text) ? status : other;
      bucket[rel] = (bucket[rel] ?? 0) + 1;
    }
  }
  return { status, other };
}

describe("direct Order writers", () => {
  const { status, other } = scan();
  it("status/paymentStatus writers outside the state machine are exactly the pinned legacy list", () => {
    expect(status).toEqual(LEGACY_STATUS_WRITERS);
  });
  it("other direct order writes (no status fields) are pinned per file", () => {
    expect(other).toEqual(NON_STATUS_WRITERS);
  });
  it("the scanner would catch a status write (self-test)", () => {
    const call = (src: string) => callText(src, [...src.matchAll(START)][0].index! + [...src.matchAll(START)][0][0].length - 1);
    expect(writesStatus(call('await db.order.update({ where: { id }, data: { paymentStatus: "paid" } });'))).toBe(true);
    expect(writesStatus(call("await tx.order.updateMany({ where: { id, status: 'awaiting_payment' }, data: { razorpayOrderId: x } });"))).toBe(false);
    expect(writesStatus(call("await db.order.update({ where: { id }, data: parsed.data });"))).toBe(true);
  });
});
