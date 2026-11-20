/**
 * Operator report (M11): launch readiness and what needs a human, for the environment in the shell (read-only).
 *   npm run ops:readiness            human-readable
 *   npm run ops:readiness -- --json  machine-readable
 * Exit code: 0 = no blocker, 2 = at least one blocker. Never prints secrets.
 */
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
async function main() {
  const { collectReadiness } = await import("../src/lib/ops/readiness");
  const { db } = await import("../src/lib/db");
  const r = await collectReadiness();
  await db.$disconnect();
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`[readiness] ${r.appEnv} — overall: ${r.overall.toUpperCase()}`);
    const mark = { ok: "✓", action: "•", blocker: "✗" } as const;
    for (const c of r.checks) console.log(`  ${mark[c.status]} [${c.area}] ${c.summary}${c.next ? `\n      next: ${c.next}` : ""}`);
  }
  process.exit(r.overall === "blocker" ? 2 : 0);
}
main().catch((e) => {
  console.error(`[readiness] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
