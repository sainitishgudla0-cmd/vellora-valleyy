import { resolveAppEnv, type AppEnv, type EnvSource } from "./app-env";

/**
 * Customer sign-in code delivery configuration (M5, ADR 0013). Pure: scripts and the build gate share it.
 * Real email delivery arrives with M7; until then the only sender is a MOCK that exists in development/test only.
 * CUSTOMER_OTP_MODE: unset = sign-in disabled (the safe default, and the only legal state in preview/production for now);
 * `mock` = codes go to an in-process outbox / the dev console, never to a customer.
 */
export const OTP_MODES = ["off", "mock"] as const;
export type OtpMode = (typeof OTP_MODES)[number];

export class OtpConfigError extends Error {
  constructor(public issues: string[]) {
    super(issues.join(" "));
    this.name = "OtpConfigError";
  }
}

export interface OtpConfig {
  mode: OtpMode;
  appEnv: AppEnv;
  warnings: string[];
}

export function resolveOtpConfig(env: EnvSource = process.env): OtpConfig {
  const appEnv = resolveAppEnv(env);
  const raw = env.CUSTOMER_OTP_MODE?.trim() || "off";
  const issues: string[] = [];
  const warnings: string[] = [];
  const mode = (OTP_MODES as readonly string[]).includes(raw) ? (raw as OtpMode) : "off";
  if (!(OTP_MODES as readonly string[]).includes(raw)) issues.push(`CUSTOMER_OTP_MODE="${raw}" is not one of ${OTP_MODES.join(", ")}.`);
  if (mode === "mock" && appEnv !== "development" && appEnv !== "test") issues.push(`CUSTOMER_OTP_MODE=mock is not allowed when APP_ENV=${appEnv}: codes would never reach customers (development/test only).`);
  if (mode === "off" && appEnv !== "development" && appEnv !== "test") warnings.push("Customer sign-in is disabled until a real OTP sender is configured (M7).");
  if (issues.length) throw new OtpConfigError(issues);
  return { mode, appEnv, warnings };
}
