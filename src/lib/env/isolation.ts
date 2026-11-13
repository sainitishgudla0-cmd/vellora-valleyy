/**
 * Database isolation between environments (M9-T2, ADR 0017). Pure (no `server-only`): used by `npm run env:check`,
 * which runs first in `vercel-build`, so a misconfigured deployment fails to build instead of touching production data.
 *
 * `PRODUCTION_DB_HOSTS` (comma-separated hostnames, NOT secret) is set in EVERY Vercel environment scope, so each
 * deployment knows which host is production:
 *  - preview: DATABASE_URL / DATABASE_URL_UNPOOLED must NOT point at a production host, and the list must exist
 *    (without it isolation cannot be shown, so the build is refused: fail closed);
 *  - production: when the list is set, DATABASE_URL must be one of those hosts (catches a swapped variable);
 *    when it is missing, a warning asks the operator to set it;
 *  - development/test: nothing to enforce here (scripts use scripts/db-guard.ts and src/lib/env/test-safety.ts).
 */
import { resolveAppEnv, type EnvSource } from "./app-env";
import { describeDatabaseUrl } from "./test-safety";

export interface IsolationResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

const hostList = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace("-pooler", ""))
    .filter(Boolean);

export function checkDatabaseIsolation(env: EnvSource = process.env): IsolationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const appEnv = resolveAppEnv(env);
  const production = hostList(env.PRODUCTION_DB_HOSTS);
  const urls: [string, string | undefined][] = [
    ["DATABASE_URL", env.DATABASE_URL],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED],
  ];

  if (appEnv === "preview") {
    for (const [name, raw] of urls) {
      if (!raw?.trim()) continue;
      const target = describeDatabaseUrl(raw);
      if (!target) {
        issues.push(`${name} is set but is not a postgres:// URL; cannot establish which database a preview would use.`);
        continue;
      }
      if (production.length === 0) {
        issues.push(`${name} is set in a preview but PRODUCTION_DB_HOSTS is not, so preview/production isolation cannot be verified. Set PRODUCTION_DB_HOSTS (host names only, not secret) in the Preview scope, and give previews their own database (a Neon branch).`);
      } else if (production.includes(target.host.replace("-pooler", ""))) {
        issues.push(`${name} in a preview points at the production database host ${target.host}. Previews must use their own database.`);
      }
    }
  }

  if (appEnv === "production") {
    if (production.length === 0) {
      warnings.push("PRODUCTION_DB_HOSTS is not set; production cannot confirm it is using the intended database. Set it to the production database host name.");
    } else {
      for (const [name, raw] of urls) {
        if (!raw?.trim()) continue;
        const target = describeDatabaseUrl(raw);
        if (!target || !production.includes(target.host.replace("-pooler", ""))) {
          issues.push(`${name} in production does not point at a host listed in PRODUCTION_DB_HOSTS (variable swapped between environments?).`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}
