/**
 * Security configuration gate (M11 P1-T5/P1-T6, ADR 0022). Pure (no `server-only`): used by `npm run env:check`, which
 * runs first in `vercel-build`, so an unsafe deployment fails to build.
 *
 *  - `RATE_LIMIT_STORE=memory` (per-instance counters) is a debugging aid: refused in preview/production, where it would
 *    multiply every limit by the number of server instances (P1-T6, F08).
 *  - The shared-password admin login (P1-T5, F05) is always off in production at runtime. Here: `ADMIN_LEGACY_LOGIN`
 *    may only be unset or `off`; in production a leftover `ADMIN_PASSWORD` is a warning (remove it), and in preview an
 *    enabled legacy login is a warning (turn it off once individual accounts exist).
 */
import { resolveAppEnv, type EnvSource } from "./app-env";

export interface SecurityConfigResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

export function checkSecurityConfig(env: EnvSource = process.env): SecurityConfigResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const appEnv = resolveAppEnv(env);
  const deployed = appEnv === "preview" || appEnv === "production";

  const store = env.RATE_LIMIT_STORE?.trim();
  if (store && store !== "memory" && store !== "database") issues.push(`RATE_LIMIT_STORE="${store}" is not one of: unset, database, memory.`);
  if (deployed && store === "memory") issues.push(`RATE_LIMIT_STORE=memory is refused in ${appEnv}: per-instance counters do not limit anything across instances. Unset it.`);

  const legacyFlag = env.ADMIN_LEGACY_LOGIN?.trim().toLowerCase();
  if (legacyFlag && legacyFlag !== "off") issues.push(`ADMIN_LEGACY_LOGIN="${env.ADMIN_LEGACY_LOGIN}" is not allowed: leave it unset or set it to "off". The shared-password login can only be switched off, never forced on.`);
  const legacyPassword = !!env.ADMIN_PASSWORD;
  if (appEnv === "production" && legacyPassword) warnings.push("ADMIN_PASSWORD is set in production, where the shared-password login is always disabled. Remove it after confirming an owner account can sign in.");
  if (appEnv === "preview" && legacyPassword && legacyFlag !== "off") warnings.push("The shared-password admin login is enabled in this preview. Set ADMIN_LEGACY_LOGIN=off once individual accounts exist.");

  return { ok: issues.length === 0, issues, warnings };
}
