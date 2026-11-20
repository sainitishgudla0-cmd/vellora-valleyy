/**
 * Operator tool (M11 P3-T3): initialise or correct stock counts from a count sheet the business supplies.
 *   npm run inventory:import -- --file counts.csv                       dry run: prints the plan, changes nothing
 *   npm run inventory:import -- --file counts.csv --apply --reason "Opening count 2026-12-01"
 * File: CSV with the header `sku,stock`, one row per variant, `stock` = units physically on hand (whole number, 0+).
 * Guarded by scripts/db-guard.ts (production needs the explicit confirmation). Never invents a number: a variant not
 * in the file is left alone and listed if it is still untracked. Re-running the same file is a no-op.
 * Every change is a ledger row (actor `system`, id `inventory-import`) carrying the reason.
 */
import fs from "node:fs";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("file");
  if (!file) throw new Error("--file <counts.csv> is required");
  const apply = process.argv.includes("--apply");
  const reason = arg("reason")?.trim() ?? "";
  if (apply && reason.length < 3) throw new Error('--reason "<why>" (3+ characters) is required with --apply');

  const { parseStockCsv, planStockImport, applyStockImport } = await import("../src/lib/inventory/import");
  const { writeAudit } = await import("../src/lib/auth/audit");
  const { db } = await import("../src/lib/db");

  const parsed = parseStockCsv(fs.readFileSync(file, "utf8"));
  const plan = parsed.errors.length ? { entries: [], errors: parsed.errors, untrackedNotInFile: [] } : await planStockImport(parsed.rows);
  for (const e of plan.entries) console.log(`  ${e.sku.padEnd(24)} ${e.action.padEnd(15)} ${e.current === null ? "untracked" : e.current} -> ${e.stock} (reserved ${e.reserved})`);
  if (plan.untrackedNotInFile.length) console.log(`[inventory] still untracked and not in the file (${plan.untrackedNotInFile.length}): ${plan.untrackedNotInFile.join(", ")}`);
  if (plan.errors.length) {
    for (const e of plan.errors) console.error(`[inventory] ${e}`);
    throw new Error(`${plan.errors.length} problem(s) in the file; nothing was changed`);
  }
  const counts = { start_tracking: 0, adjust: 0, unchanged: 0 };
  for (const e of plan.entries) counts[e.action]++;
  console.log(`[inventory] plan: ${JSON.stringify(counts)}`);
  if (!apply) {
    console.log("[inventory] dry run: nothing changed. Re-run with --apply --reason \"…\" to apply.");
    await db.$disconnect();
    return;
  }
  const results = await applyStockImport(plan, { type: "system", id: "inventory-import" }, reason);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.error(`[inventory] ${r.sku}: ${r.error}`);
  await writeAudit({ action: "inventory.import", outcome: failed.length ? "failed" : "success", admin: { userId: null, label: "inventory-import-script", role: "owner" }, details: { ...counts, failed: failed.length } });
  console.log(`[inventory] applied: ${results.length - failed.length} ok, ${failed.length} refused`);
  await db.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(`[inventory] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
