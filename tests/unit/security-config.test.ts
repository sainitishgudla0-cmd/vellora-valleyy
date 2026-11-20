/** M11 P1-T5: `env:check` never lets the shared-password admin login be forced on, and flags it where it lingers. */
import { describe, expect, it } from "vitest";
import { checkSecurityConfig } from "@/lib/env/security-config";

describe("env:check shared-password admin gate", () => {
  it("ADMIN_LEGACY_LOGIN may only be unset or off, in every environment", () => {
    for (const env of [{ APP_ENV: "test" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }]) {
      expect(checkSecurityConfig({ ...env, ADMIN_LEGACY_LOGIN: "on" }).ok).toBe(false);
      expect(checkSecurityConfig({ ...env, ADMIN_LEGACY_LOGIN: "true" }).ok).toBe(false);
      expect(checkSecurityConfig({ ...env, ADMIN_LEGACY_LOGIN: "off" }).ok).toBe(true);
      expect(checkSecurityConfig({ ...env, ADMIN_LEGACY_LOGIN: "OFF" }).ok).toBe(true);
      expect(checkSecurityConfig(env).ok).toBe(true);
    }
  });

  it("warns about a leftover ADMIN_PASSWORD in production and an enabled shared login in preview", () => {
    expect(checkSecurityConfig({ VERCEL_ENV: "production", ADMIN_PASSWORD: "x" }).warnings.join(" ")).toMatch(/always disabled/);
    expect(checkSecurityConfig({ VERCEL_ENV: "preview", ADMIN_PASSWORD: "x" }).warnings.join(" ")).toMatch(/ADMIN_LEGACY_LOGIN=off/);
    expect(checkSecurityConfig({ VERCEL_ENV: "preview", ADMIN_PASSWORD: "x", ADMIN_LEGACY_LOGIN: "off" }).warnings).toEqual([]);
    expect(checkSecurityConfig({ APP_ENV: "test", ADMIN_PASSWORD: "x" }).warnings).toEqual([]);
  });
});
