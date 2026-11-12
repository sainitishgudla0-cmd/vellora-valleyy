/**
 * Resolves which environment this process runs in. Pure (no `server-only`) so scripts can share it.
 * See docs/DECISIONS/0002-environment-and-payment-modes.md.
 *
 * Precedence and fail-closed rules:
 * - On Vercel, VERCEL_ENV is authoritative. APP_ENV may be set but must agree with it, so a deployment
 *   can never claim to be "test" or "development".
 * - Off Vercel, APP_ENV is used when set.
 * - Otherwise NODE_ENV decides; NODE_ENV=production (e.g. `next start`) resolves to "production".
 */
export const APP_ENVS = ["development", "test", "preview", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export type EnvSource = Record<string, string | undefined>;

export class EnvSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvSafetyError";
  }
}

const isAppEnv = (v: string): v is AppEnv => (APP_ENVS as readonly string[]).includes(v);

export function resolveAppEnv(env: EnvSource = process.env): AppEnv {
  const appEnv = env.APP_ENV?.trim() || undefined;
  if (appEnv !== undefined && !isAppEnv(appEnv)) {
    throw new EnvSafetyError(`APP_ENV="${appEnv}" is not one of ${APP_ENVS.join(", ")}.`);
  }

  const vercelEnv = env.VERCEL_ENV?.trim() || undefined;
  if (vercelEnv !== undefined) {
    if (vercelEnv !== "production" && vercelEnv !== "preview" && vercelEnv !== "development") {
      throw new EnvSafetyError(`Unrecognised VERCEL_ENV="${vercelEnv}".`);
    }
    if (appEnv !== undefined && appEnv !== vercelEnv) {
      throw new EnvSafetyError(`APP_ENV="${appEnv}" contradicts VERCEL_ENV="${vercelEnv}". Remove APP_ENV or make them match.`);
    }
    return vercelEnv;
  }

  if (appEnv !== undefined) return appEnv;
  if (env.NODE_ENV === "test") return "test";
  if (env.NODE_ENV === "production") return "production";
  return "development";
}
