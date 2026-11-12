import { fail, json } from "@/lib/api";
import { resolveAppEnv } from "@/lib/env/app-env";
import { assertDisposableDatabase, assertTestTargetDeclared } from "@/lib/env/test-safety";

export const dynamic = "force-dynamic";

/**
 * Handshake for write-capable tests (docs/API-CONTRACTS.md#test-environment).
 * Production and preview deployments always answer 404, so a test runner can never confirm them as disposable.
 * Elsewhere it reports whether THIS server's own database is disposable; tests abort unless testWritesAllowed is true.
 */
export async function GET() {
  let appEnv;
  try {
    appEnv = resolveAppEnv();
  } catch {
    return fail("Not found", 404);
  }
  if (appEnv === "production" || appEnv === "preview") return fail("Not found", 404);

  const reasons: string[] = [];
  try {
    assertTestTargetDeclared();
    assertDisposableDatabase(process.env, "write-capable tests");
  } catch (e) {
    reasons.push(e instanceof Error ? e.message : String(e));
  }
  return json({ appEnv, testWritesAllowed: reasons.length === 0, reasons });
}
