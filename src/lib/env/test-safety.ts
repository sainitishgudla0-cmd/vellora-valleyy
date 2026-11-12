/**
 * Safety guards for write-capable tests and database-changing scripts. Pure (no `server-only`).
 * Everything fails closed: if the target cannot be positively identified as disposable, it is refused.
 * Canonical description: docs/DECISIONS/0003-test-and-database-safety.md.
 */
import { resolveAppEnv, type EnvSource, EnvSafetyError } from "./app-env";

/** Production hosts that tests may never target, whatever the overrides. */
export const KNOWN_PRODUCTION_HOSTS = ["velora-valley.vercel.app", "veloravalley.com", "www.veloravalley.com"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.toLowerCase());

function productionHosts(env: EnvSource) {
  return new Set<string>([...KNOWN_PRODUCTION_HOSTS, ...list(env.PRODUCTION_HOSTS)]);
}

/** Write-capable tests must be explicitly pointed at a disposable environment. */
export function assertTestTargetDeclared(env: EnvSource = process.env) {
  if (env.TEST_TARGET?.trim() !== "disposable") {
    throw new EnvSafetyError("Write-capable tests and destructive scripts require TEST_TARGET=disposable (an isolated, throwaway database).");
  }
}

/**
 * Validates the base URL a write-capable HTTP test will hit.
 * Loopback is allowed; any other host must be listed in TEST_ALLOWED_HOSTS; production hosts are always refused.
 */
export function assertSafeTestUrl(baseUrl: string | undefined, env: EnvSource = process.env): URL {
  assertTestTargetDeclared(env);
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
  } catch {
    throw new EnvSafetyError(`BASE_URL "${baseUrl ?? ""}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new EnvSafetyError(`BASE_URL must be http(s), got ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (productionHosts(env).has(host)) throw new EnvSafetyError(`Refusing to run write-capable tests against production host ${host}.`);
  if (!isLoopbackHost(host) && !list(env.TEST_ALLOWED_HOSTS).includes(host)) {
    throw new EnvSafetyError(`Host ${host} is not loopback and not listed in TEST_ALLOWED_HOSTS; refusing write-capable tests.`);
  }
  return url;
}

export interface DatabaseTarget {
  host: string;
  database: string;
}

/** Parses a Postgres URL without ever returning credentials. Returns null when it cannot be parsed. */
export function describeDatabaseUrl(raw: string | undefined): DatabaseTarget | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    if (!u.hostname) return null;
    return { host: u.hostname.toLowerCase(), database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return null;
  }
}

function checkDatabaseUrl(name: string, raw: string | undefined, env: EnvSource): DatabaseTarget {
  const target = describeDatabaseUrl(raw);
  if (!target) throw new EnvSafetyError(`${name} is missing or is not a postgres:// URL; cannot establish database identity.`);
  if (list(env.PRODUCTION_DB_HOSTS).includes(target.host)) throw new EnvSafetyError(`${name} points at production database host ${target.host}.`);
  if (!isLoopbackHost(target.host) && !list(env.DISPOSABLE_DB_HOSTS).includes(target.host)) {
    throw new EnvSafetyError(`${name} host ${target.host} is not loopback and not listed in DISPOSABLE_DB_HOSTS; refusing.`);
  }
  return target;
}

/**
 * Asserts that DATABASE_URL (and DATABASE_URL_UNPOOLED, if set) point at a disposable database
 * and that the process is a development/test environment.
 */
export function assertDisposableDatabase(env: EnvSource = process.env, operation = "this operation"): DatabaseTarget {
  const appEnv = resolveAppEnv(env);
  if (appEnv !== "development" && appEnv !== "test") {
    throw new EnvSafetyError(`Refusing ${operation}: APP_ENV resolves to "${appEnv}" (only development or test are allowed).`);
  }
  const main = checkDatabaseUrl("DATABASE_URL", env.DATABASE_URL, env);
  if (env.DATABASE_URL_UNPOOLED?.trim()) checkDatabaseUrl("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED, env);
  return main;
}

/**
 * Database writes that may legitimately target production (catalogue sync, production migrations) need an
 * explicit, per-run confirmation: APP_ENV=production and CONFIRM_PRODUCTION_DB_HOST equal to the target host.
 * Without that, the database must be disposable.
 */
export function assertDatabaseWriteAllowed(env: EnvSource = process.env, operation = "this operation"): DatabaseTarget & { production: boolean } {
  const confirm = env.CONFIRM_PRODUCTION_DB_HOST?.trim().toLowerCase();
  if (!confirm) return { ...assertDisposableDatabase(env, operation), production: false };

  if (resolveAppEnv(env) !== "production") throw new EnvSafetyError(`CONFIRM_PRODUCTION_DB_HOST is set but APP_ENV is not production; refusing ${operation}.`);
  const targets = [describeDatabaseUrl(env.DATABASE_URL), env.DATABASE_URL_UNPOOLED?.trim() ? describeDatabaseUrl(env.DATABASE_URL_UNPOOLED) : undefined];
  for (const t of targets) {
    if (t === null) throw new EnvSafetyError(`Database URL cannot be parsed; refusing ${operation}.`);
    if (t && t.host !== confirm && t.host.replace("-pooler", "") !== confirm) {
      throw new EnvSafetyError(`CONFIRM_PRODUCTION_DB_HOST (${confirm}) does not match database host ${t.host}; refusing ${operation}.`);
    }
  }
  return { ...(targets[0] as DatabaseTarget), production: true };
}
