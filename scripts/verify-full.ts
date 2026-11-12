/**
 * Milestone gate: the full pipeline against a DISPOSABLE Postgres (used locally and in CI).
 *   TEST_TARGET=disposable APP_ENV=test DATABASE_URL=postgresql://...@127.0.0.1:5432/velora_test npm run verify:full
 *
 * 1. guard: TEST_TARGET=disposable + disposable database (fails closed)
 * 2. typecheck, unit tests, env check
 * 3. prisma migrate deploy -> schema drift check -> catalogue seed
 * 4. integration tests (real Postgres)
 * 5. next build -> next start on VERIFY_PORT (default 3100) -> API smoke test -> stop server
 * Set VERIFY_UI=1 to also run the Playwright browser tests (tests/e2e; needs Chrome, CHROME_PATH). The server is then started with the mock
 * sign-in sender and a fake seller GSTIN so the account, wholesale and invoice journeys can run; visual baselines are compared where they exist.
 */
import { spawn, spawnSync } from "node:child_process";
import { assertDisposableDatabase, assertTestTargetDeclared } from "../src/lib/env/test-safety";
import { gstinCheckChar } from "../src/lib/wholesale/gstin";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
try {
  assertTestTargetDeclared();
  const t = assertDisposableDatabase(process.env, "verify:full");
  console.log(`[verify:full] disposable database: ${t.host}/${t.database}`);
} catch (e) {
  console.error(`[verify:full] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const PORT = process.env.VERIFY_PORT ?? "3100";
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" };
// Browser tests need a server that can show what only exists on a disposable test instance: a mock sign-in code sender (never allowed
// in preview/production by env:check) and a seller GSTIN to invoice with (a well-formed fake: state 37 + check character).
const sellerBody = "37AAAAA0000A1Z";
const serverEnv = process.env.VERIFY_UI === "1" ? { ...env, CUSTOMER_OTP_MODE: "mock", SELLER_GSTIN: sellerBody + gstinCheckChar(sellerBody) } : env;

function step(name: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}) {
  console.log(`\n[verify:full] ▶ ${name}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...env, ...extraEnv } });
  // throw (not exit) so the `finally` below always stops the server
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status})`);
  console.log(`[verify:full] ✓ ${name}`);
}

async function waitFor(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready at ${url}`);
}

async function main() {
  step("typecheck", "npm", ["run", "-s", "typecheck"]);
  step("unit tests", "npm", ["run", "-s", "test"]);
  step("env check", "npm", ["run", "-s", "env:check"]);
  step("migrate deploy", "npm", ["run", "-s", "db:migrate:deploy"]);
  step("schema drift check", "npm", ["run", "-s", "db:schema:diff"]);
  step("seed catalogue", "npm", ["run", "-s", "db:seed"]);
  step("integration tests", "npm", ["run", "-s", "test:integration"]);
  step("next build", "npm", ["run", "-s", "build"]);

  console.log(`\n[verify:full] ▶ start server on ${BASE}`);
  const server = spawn("npx", ["next", "start", "-p", PORT, "-H", "127.0.0.1"], { stdio: ["ignore", "inherit", "inherit"], env: serverEnv, detached: true });
  const stop = () => {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  try {
    await waitFor(`${BASE}/api/internal/test-environment`);
    step("API smoke test", "npm", ["run", "-s", "test:api"], { BASE_URL: BASE });
    if (process.env.VERIFY_UI === "1") {
      // The admin UI test needs an owner account. Created through the same guarded bootstrap script operators use,
      // against this run's disposable database, with a throwaway password that never leaves this process.
      const ownerEmail = `smoke.ui-owner-${Date.now()}@example.com`;
      const ownerPassword = `ui-test-${Math.random().toString(36).slice(2)}-passphrase`;
      step("UI test owner account", "npm", ["run", "-s", "admin:bootstrap", "--", "--email", ownerEmail, "--name", "UI Test Owner", "--additional-owner"], { ADMIN_BOOTSTRAP_PASSWORD: ownerPassword });
      step("browser tests (Playwright)", "npx", ["playwright", "test"], { E2E_BASE_URL: BASE, UI_TEST_ADMIN_EMAIL: ownerEmail, UI_TEST_ADMIN_PASSWORD: ownerPassword });
    }
  } finally {
    stop();
  }
  console.log("\n[verify:full] ✓ all gates passed");
}

main().catch((e) => {
  console.error(`[verify:full] ✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
