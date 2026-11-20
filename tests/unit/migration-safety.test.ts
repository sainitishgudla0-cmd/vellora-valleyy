/**
 * M11 P2-T3: release compatibility. Within the backend line the previous app version must keep working on the next
 * schema (RELEASE.md C2), so a migration may only ADD: no drops, renames, type changes, truncation, deletes, and no
 * NOT NULL column without a default on a table that already existed. Exceptions are pinned here with their ADR.
 * The one-time cutover from `main` (M2 enum cast) is NOT compatible in either direction: see RUNBOOK-DATABASE.md
 * "Release compatibility matrix".
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.resolve(__dirname, "../../prisma/migrations");
const migrations = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort();
const sql = (m: string) =>
  fs
    .readFileSync(path.join(dir, m, "migration.sql"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");

/** Pinned, reviewed exceptions: migration -> the rule it breaks and why it is acceptable. */
const EXCEPTIONS: Record<string, string[]> = {
  // ADR 0005: TEXT -> native enums, in-place cast with a pre-check. Breaks `main` (see the compatibility matrix).
  "20261112021101_order_payment_enums": ["type change"],
};

const RULES: [string, RegExp][] = [
  ["drop", /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|VIEW)\b/i],
  ["rename", /\bRENAME\b/i],
  ["type change", /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i],
  ["set not null", /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i],
  ["truncate", /\bTRUNCATE\b/i],
  ["delete", /\bDELETE\s+FROM\b/i],
];

describe("migrations are additive (M11 P2-T3)", () => {
  it("are applied in name order, 0_init first, each with a migration.sql", () => {
    expect(migrations[0]).toBe("0_init");
    for (const m of migrations.slice(1)) expect(m).toMatch(/^\d{14}_[a-z0-9_]+$/);
    for (const m of migrations) expect(fs.existsSync(path.join(dir, m, "migration.sql")), m).toBe(true);
  });

  it("contain no destructive statement outside the pinned exceptions", () => {
    const found: Record<string, string[]> = {};
    for (const m of migrations.slice(1)) {
      const hits = RULES.filter(([, re]) => re.test(sql(m))).map(([name]) => name);
      if (hits.length) found[m] = hits;
    }
    expect(found).toEqual(EXCEPTIONS);
  });

  it("never add a NOT NULL column without a default to a table that already existed", () => {
    const offenders: string[] = [];
    for (const m of migrations.slice(1)) {
      const s = sql(m);
      // tables created in this same migration have no old rows or old writers
      const fresh = new Set([...s.matchAll(/CREATE TABLE\s+"(\w+)"/g)].map((x) => x[1]));
      for (const a of s.matchAll(/ALTER TABLE\s+"(\w+)"([^;]*);/g)) {
        if (fresh.has(a[1])) continue;
        for (const col of a[2].matchAll(/ADD COLUMN\s+"(\w+)"\s+([^,]*)/g)) {
          if (/NOT NULL/i.test(col[2]) && !/DEFAULT/i.test(col[2])) offenders.push(`${m}: ${a[1]}.${col[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
