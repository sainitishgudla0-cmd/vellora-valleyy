/**
 * Shared helpers for scripts that write to a database or a running server.
 * Scripts load `.env` (like the Prisma CLI) but never override variables already set in the shell.
 */
import fs from "node:fs";
import type { EnvSource } from "../../src/lib/env/app-env";
import { assertSafeTestUrl } from "../../src/lib/env/test-safety";

export function loadLocalEnv(file = ".env") {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/**
 * Full pre-flight for write-capable HTTP tests: validates the URL locally, then asks the server to
 * confirm that its own database is disposable. Any other answer (404, error, false) aborts.
 */
export async function assertServerIsDisposable(baseUrl: string | undefined, env: EnvSource = process.env): Promise<URL> {
  const url = assertSafeTestUrl(baseUrl, env);
  const probe = new URL("/api/internal/test-environment", url);
  let body: { testWritesAllowed?: unknown; reasons?: unknown } | undefined;
  try {
    const res = await fetch(probe, { redirect: "manual", cache: "no-store" });
    if (res.ok) body = await res.json();
    else throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(`Cannot confirm ${url.origin} is a disposable test server (${e instanceof Error ? e.message : e}). Aborting before any write.`);
  }
  if (body?.testWritesAllowed !== true) {
    throw new Error(`Server ${url.origin} refused write-capable tests: ${JSON.stringify(body?.reasons ?? body)}. Aborting before any write.`);
  }
  return url;
}
