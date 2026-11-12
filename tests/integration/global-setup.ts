import { assertDisposableDatabase, assertTestTargetDeclared } from "../../src/lib/env/test-safety";
import { loadLocalEnv } from "../../scripts/lib/safety";

/** Runs once before any integration test. Throwing here aborts the whole run before a single write. */
export default function setup() {
  loadLocalEnv();
  assertTestTargetDeclared();
  const t = assertDisposableDatabase(process.env, "integration tests");
  console.log(`[integration] disposable database confirmed: ${t.host}/${t.database}`);
}
