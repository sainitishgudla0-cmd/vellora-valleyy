/**
 * Pre-flight guard for database-changing npm scripts (see package.json "db:*").
 *   tsx scripts/db-guard.ts <operation>              -> database must be disposable
 *   tsx scripts/db-guard.ts <operation> --production -> also allows an explicitly confirmed production target
 * Exits non-zero (and the chained Prisma command never runs) when the target cannot be proven safe.
 */
import { assertDatabaseWriteAllowed, assertDisposableDatabase } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
const operation = process.argv[2] ?? "database change";
const allowProduction = process.argv.includes("--production");

try {
  const t = allowProduction ? assertDatabaseWriteAllowed(process.env, operation) : { ...assertDisposableDatabase(process.env, operation), production: false };
  console.log(`[db-guard] ${operation}: target ${t.host}/${t.database}${t.production ? " (PRODUCTION, explicitly confirmed)" : " (disposable)"}`);
} catch (e) {
  console.error(`[db-guard] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
