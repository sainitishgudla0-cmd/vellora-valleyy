import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * M9-T6 (ADR 0017). `npm run lint` runs in CI; errors fail the build, and `--max-warnings` ratchets the known
 * warnings down (it never goes up).
 *
 * The customer-facing frontend (src/components, src/store, page files) is approved and frozen, so its existing
 * findings are recorded as warnings instead of being "fixed" with behaviour-changing edits:
 *  - react-hooks/set-state-in-effect: the animation/hydration code sets state in effects on purpose;
 *  - no-unused-expressions / no-explicit-any: short-circuit calls in GSAP/Lenis setup and one admin helper.
 */
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "node_modules/**", "public/**", "test-results/**", "playwright-report/**", "next-env.d.ts", "tests/e2e/__screenshots__/**", "docs/**", "**/* 2.*", "**/* 2/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/components/**", "src/store/**"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // fixtures and scripts parse loosely typed JSON on purpose
    files: ["tests/**", "scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);
