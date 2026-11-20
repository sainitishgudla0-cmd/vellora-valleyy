/**
 * Visual regression against an approved commit, on the machine that runs it (M11 P5-T3, finding F15).
 *   TEST_TARGET=disposable APP_ENV=test DATABASE_URL=… npm run test:visual-ref [-- --ref <sha>]
 *
 * Screenshot baselines depend on the platform's fonts and anti-aliasing, and committing them (≈50 MB per platform) bloats
 * the repository. Instead this builds the APPROVED design commit (`tests/e2e/visual-baseline.ref`, or --ref), captures the
 * 22 storefront screenshots from it, then builds the current checkout and compares, both on the same machine against the
 * same seeded disposable database. CI runs it on Linux; it works the same on macOS.
 *
 * Steps: git worktree of the ref (detached, outside the repo) -> npm ci -> prisma generate -> next build -> serve on
 * VISUAL_REF_PORT (3200) -> `playwright test visual --update-snapshots=all` -> stop -> next build (current) -> serve on
 * VISUAL_PORT (3300) -> `playwright test visual` (fails on > 0.1% pixel difference) -> stop -> remove the worktree.
 * The database must already be migrated to the current schema and seeded; schema changes are additive, so the older
 * ref's client reads it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDisposableDatabase, assertTestTargetDeclared } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
assertTestTargetDeclared();
assertDisposableDatabase(process.env, "visual regression");

const root = path.resolve(__dirname, "..");
const argRef = process.argv.includes("--ref") ? process.argv[process.argv.indexOf("--ref") + 1] : undefined;
const ref = (argRef ?? fs.readFileSync(path.join(root, "tests/e2e/visual-baseline.ref"), "utf8")).trim();
if (!/^[0-9a-f]{7,40}$/.test(ref)) throw new Error(`visual baseline ref must be a commit SHA, got "${ref}"`);
const REF_PORT = process.env.VISUAL_REF_PORT ?? "3200";
const PORT = process.env.VISUAL_PORT ?? "3300";
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };

function step(name: string, cmd: string, args: string[], cwd = root, extra: Record<string, string> = {}) {
  console.log(`\n[visual] ▶ ${name}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...env, ...extra } });
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status})`);
}

async function serve(cwd: string, port: string): Promise<ChildProcess> {
  const p = spawn("npx", ["next", "start", "-p", port, "-H", "127.0.0.1"], { cwd, env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/internal/test-environment`)).ok) return p;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop(p);
  throw new Error(`server in ${cwd} did not start on ${port}`);
}

function stop(p: ChildProcess | undefined) {
  try {
    if (p?.pid) process.kill(-p.pid, "SIGTERM");
  } catch {
    /* gone */
  }
}

async function main() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "vv-visual-ref-"));
  let server: ChildProcess | undefined;
  try {
    step(`check out approved design ${ref}`, "git", ["worktree", "add", "--detach", "--force", wt, ref]);
    step("install (ref)", "npm", ["ci", "--no-audit", "--no-fund"], wt);
    step("build (ref)", "npm", ["run", "-s", "build"], wt);
    server = await serve(wt, REF_PORT);
    step("capture baselines from the ref", "npx", ["playwright", "test", "visual", "--update-snapshots=all"], root, { E2E_BASE_URL: `http://127.0.0.1:${REF_PORT}` });
    stop(server);
    server = undefined;

    step("build (current)", "npm", ["run", "-s", "build"]);
    server = await serve(root, PORT);
    step("compare current with the ref", "npx", ["playwright", "test", "visual"], root, { E2E_BASE_URL: `http://127.0.0.1:${PORT}` });
    console.log(`\n[visual] ✓ storefront pages are visually identical to ${ref}`);
  } finally {
    stop(server);
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: root, stdio: "ignore" });
  }
}

main().catch((e) => {
  console.error(`\n[visual] ✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
