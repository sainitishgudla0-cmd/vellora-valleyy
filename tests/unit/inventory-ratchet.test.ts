/**
 * Ratchet for the M3 acceptance criterion "stock counters change only through the ledger" (ADR 0011).
 * Outside src/lib/inventory/, no code under src/ or scripts/ may write Variant.stockQuantity / reserved / trackInventory
 * (Prisma update/updateMany/upsert/create, or raw SQL against "Variant"). prisma/seed.ts is not scanned: it never
 * sets these columns, which the self-test below also pins by checking its upsert data.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START = /\b(?:db|tx|prisma)\.variant\.(?:update|updateMany|upsert|create|createMany)\s*\(|\$(?:executeRaw|queryRaw)[A-Za-z]*\s*[`(]/g;
const GUARDED = /\b(?:stockQuantity|reserved|trackInventory)\b/;
const ALLOWED_DIR = "src/lib/inventory/";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

function callText(src: string, openIdx: number): string {
  if (src[openIdx] === "`") return src.slice(openIdx, src.indexOf("`", openIdx + 1) + 1);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

/** True when the call writes the guarded columns: raw SQL touching "Variant", or a Prisma call whose data names them (or is not a literal). */
export function writesStock(call: string): boolean {
  if (call.startsWith("`") || /\$(?:executeRaw|queryRaw)/.test(call)) return /"Variant"/.test(call) && /\b(?:UPDATE|INSERT|DELETE)\b/i.test(call);
  const m = /\bdata\s*:\s*/.exec(call);
  if (!m) return false;
  const rest = call.slice(m.index + m[0].length);
  if (rest[0] !== "{") return true;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}" && --depth === 0) return GUARDED.test(rest.slice(0, i + 1));
  }
  return true;
}

function scan() {
  const hits: string[] = [];
  for (const f of [...walk("src"), ...walk("scripts")]) {
    const rel = f.split(path.sep).join("/");
    if (rel.startsWith(ALLOWED_DIR)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(START)) {
      // raw calls: START ends at the opening backtick/paren; the template text follows
      const text = callText(src, m.index! + m[0].length - 1);
      if (writesStock(m[0].startsWith("$") ? `${m[0]}${text}` : text)) hits.push(rel);
    }
  }
  return hits;
}

describe("stock counters are written only by src/lib/inventory", () => {
  it("no other file writes stockQuantity / reserved / trackInventory", () => {
    expect(scan()).toEqual([]);
  });
  it("the scanner catches Prisma and raw-SQL writes (self-test)", () => {
    const first = (src: string) => {
      const m = [...src.matchAll(START)][0];
      const text = callText(src, m.index! + m[0].length - 1);
      return writesStock(m[0].startsWith("$") ? `${m[0]}${text}` : text);
    };
    expect(first("await db.variant.update({ where: { id }, data: { stockQuantity: 5 } });")).toBe(true);
    expect(first("await tx.variant.updateMany({ where: { id }, data: { reserved: { increment: 1 } } });")).toBe(true);
    expect(first("await db.variant.update({ where: { id }, data: parsed.data });")).toBe(true);
    expect(first('await tx.$executeRaw`UPDATE "Variant" SET "reserved" = 1`;')).toBe(true);
    expect(first("await db.variant.update({ where: { id }, data: { price: 100, inStock: true } });")).toBe(false);
    expect(first('await db.$queryRaw`SELECT "reserved" FROM "Variant"`;')).toBe(false);
  });
  it("the seed's variant upsert never sets stock columns", () => {
    const seed = fs.readFileSync("prisma/seed.ts", "utf8");
    expect(seed).not.toMatch(/\b(?:stockQuantity|reserved|trackInventory)\b/);
  });
});
