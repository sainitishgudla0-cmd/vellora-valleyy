import { defineConfig } from "vitest/config";
import { alias, testDefaults } from "./vitest.shared.mts";

/** Unit tests: no database, no network. `npm run test` */
export default defineConfig({
  resolve: { alias },
  test: { ...testDefaults, include: ["tests/unit/**/*.test.ts"] },
});
