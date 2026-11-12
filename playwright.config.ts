import { defineConfig } from "@playwright/test";

/**
 * Browser end-to-end tests (M8-T5): journeys for guests, signed-in customers, wholesale buyers and admins, plus a visual
 * regression check of the existing pages. They drive a running server (default http://127.0.0.1:3100, as started by
 * `npm run verify:full`) and refuse to run unless that server proves its database is disposable (global-setup).
 *   E2E_BASE_URL / BASE_URL   server to test          CHROME_PATH   Chrome binary (default: the installed "chrome" channel)
 */
const baseURL = process.env.E2E_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1, // journeys share one disposable database
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  // Baselines are per platform: fonts and anti-aliasing differ between macOS and Linux, so a baseline made on one is not compared on the other.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: "disabled", caret: "hide" } },
  use: {
    baseURL,
    ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : { channel: "chrome" }),
    trace: "retain-on-failure",
  },
  outputDir: "test-results",
});
