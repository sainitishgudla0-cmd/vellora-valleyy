import { describe, expect, it } from "vitest";
import { EnvSafetyError, resolveAppEnv } from "@/lib/env/app-env";

describe("resolveAppEnv", () => {
  it("uses VERCEL_ENV on Vercel", () => {
    expect(resolveAppEnv({ VERCEL_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
  });

  it("refuses an APP_ENV that contradicts VERCEL_ENV (no downgrading a deployment to test)", () => {
    expect(() => resolveAppEnv({ VERCEL_ENV: "production", APP_ENV: "test" })).toThrow(EnvSafetyError);
    expect(() => resolveAppEnv({ VERCEL_ENV: "preview", APP_ENV: "development" })).toThrow(EnvSafetyError);
    expect(resolveAppEnv({ VERCEL_ENV: "preview", APP_ENV: "preview" })).toBe("preview");
  });

  it("rejects unknown values", () => {
    expect(() => resolveAppEnv({ APP_ENV: "staging" })).toThrow(EnvSafetyError);
    expect(() => resolveAppEnv({ VERCEL_ENV: "qa" })).toThrow(EnvSafetyError);
  });

  it("uses APP_ENV off Vercel", () => {
    expect(resolveAppEnv({ APP_ENV: "test", NODE_ENV: "production" })).toBe("test");
  });

  it("falls back to NODE_ENV and treats an unlabelled production build as production (fail closed)", () => {
    expect(resolveAppEnv({ NODE_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ NODE_ENV: "test" })).toBe("test");
    expect(resolveAppEnv({ NODE_ENV: "development" })).toBe("development");
    expect(resolveAppEnv({})).toBe("development");
  });
});
