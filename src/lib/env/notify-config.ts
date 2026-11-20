import { resolveAppEnv, type AppEnv, type EnvSource } from "./app-env";
import { parseSmtpConfig, type SmtpConfig } from "./smtp-config";

/**
 * Notification delivery configuration (M7-T5, ADR 0015). Pure.
 * NOTIFY_MODE: unset/`off` = nothing is queued or sent (the safe default, and the only legal state in preview/production until a
 * real provider adapter exists); `mock` = messages are queued and "delivered" to an in-process mailbox only, never to a real
 * recipient, and is refused in preview/production; `smtp` (M11 P3-T1) = real delivery through the SMTP provider in
 * `SMTP_URL`/`EMAIL_FROM` (`smtp-config.ts`), refused unless that configuration is complete and safe.
 */
export const NOTIFY_MODES = ["off", "mock", "smtp"] as const;
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
  /** present when mode = smtp */
  smtp: SmtpConfig | null;
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
  let smtp: SmtpConfig | null = null;
  if (mode === "smtp") {
    const p = parseSmtpConfig(env, appEnv);
    for (const i of p.issues) issues.push(`NOTIFY_MODE=smtp: ${i}`);
    smtp = p.config;
  }
  if (mode === "off" && (appEnv === "production" || appEnv === "preview")) warnings.push("Order and invoice notifications are disabled until a real email provider is configured (NOTIFY_MODE=smtp).");
  if (issues.length) throw new NotifyConfigError(issues);
  return { mode, appEnv, smtp, warnings };
}
