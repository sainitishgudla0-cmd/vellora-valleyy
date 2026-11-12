import { resolveAppEnv, type AppEnv, type EnvSource } from "./app-env";

/**
 * Notification delivery configuration (M7-T5, ADR 0015). Pure.
 * NOTIFY_MODE: unset/`off` = nothing is queued or sent (the safe default, and the only legal state in preview/production until a
 * real provider adapter exists); `mock` = messages are queued and "delivered" to an in-process mailbox only, never to a real
 * recipient, and is refused in preview/production.
 */
export const NOTIFY_MODES = ["off", "mock"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export class NotifyConfigError extends Error {
  constructor(public issues: string[]) {
    super(issues.join(" "));
    this.name = "NotifyConfigError";
  }
}

export interface NotifyConfig {
  mode: NotifyMode;
  appEnv: AppEnv;
  warnings: string[];
}

export function resolveNotifyConfig(env: EnvSource = process.env): NotifyConfig {
  const appEnv = resolveAppEnv(env);
  const raw = env.NOTIFY_MODE?.trim() || "off";
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!(NOTIFY_MODES as readonly string[]).includes(raw)) issues.push(`NOTIFY_MODE="${raw}" is not one of ${NOTIFY_MODES.join(", ")}.`);
  const mode = (NOTIFY_MODES as readonly string[]).includes(raw) ? (raw as NotifyMode) : "off";
  if (mode === "mock" && appEnv !== "development" && appEnv !== "test") issues.push(`NOTIFY_MODE=mock is not allowed when APP_ENV=${appEnv}: messages would silently never reach customers (development/test only).`);
  if (mode === "off" && (appEnv === "production" || appEnv === "preview")) warnings.push("Order and invoice notifications are disabled until a real email provider is configured.");
  if (issues.length) throw new NotifyConfigError(issues);
  return { mode, appEnv, warnings };
}
