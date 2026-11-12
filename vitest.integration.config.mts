import { defineConfig } from "vitest/config";
import { alias, testDefaults } from "./vitest.shared.mts";

/**
 * Integration tests against a real, disposable Postgres (`npm run test:integration`).
 * tests/integration/global-setup.ts aborts before any test runs unless the database is proven disposable.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    ...testDefaults,
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
  },
});
