import { fileURLToPath } from "node:url";

/** Shared by vitest.config.mts (unit) and vitest.integration.config.mts. */
export const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // `server-only` throws outside the React Server bundle; tests import server modules directly.
  "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
};

export const testDefaults = { environment: "node", restoreMocks: true, unstubEnvs: true, unstubGlobals: true } as const;
