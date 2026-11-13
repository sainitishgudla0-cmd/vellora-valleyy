/**
 * Payment configuration contract. Pure (no `server-only`) so build scripts can validate it.
 * Canonical description: docs/DECISIONS/0002-environment-and-payment-modes.md.
 *
 *   mode           allowed APP_ENV                    keys
 *   mock           development, test                  ignored (no online gateway)
 *   request_only   any                                ignored (order request, payment pending)
 *   razorpay_test  development, test, preview         rzp_test_* id + secret required
 *   razorpay_live  production + RAZORPAY_LIVE_ENABLED  rzp_live_* id + secret + RAZORPAY_WEBHOOK_SECRET required
 *
 * RAZORPAY_WEBHOOK_SECRET (the secret set on the Razorpay webhook, not the API key secret) enables
 * POST /api/payments/razorpay/webhook; without it the endpoint answers 503 and reconciliation is the only backstop.
 * Live Razorpay keys outside production are always rejected, whatever the mode.
 * PAYMENT_MODE unset => request_only (configured keys are ignored, with a warning).
 * MOCK_PAYMENT_CONFIRM_KEY (mock confirmation credential) is rejected in preview and production.
 */
import { resolveAppEnv, type AppEnv, type EnvSource, EnvSafetyError } from "./app-env";

export const PAYMENT_MODES = ["mock", "request_only", "razorpay_test", "razorpay_live"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export interface PaymentConfig {
  mode: PaymentMode;
  appEnv: AppEnv;
  /** true only when a real gateway checkout may be offered to customers */
  onlinePayments: boolean;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string | null } | null;
  warnings: string[];
}

/** Shortest webhook secret accepted: it is the only thing that authenticates the gateway to us. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

export class PaymentConfigError extends Error {
  constructor(public issues: string[]) {
    super(`Invalid payment configuration: ${issues.join(" ")}`);
    this.name = "PaymentConfigError";
  }
}

const ALLOWED_ENVS: Record<PaymentMode, readonly AppEnv[]> = {
  mock: ["development", "test"],
  request_only: ["development", "test", "preview", "production"],
  razorpay_test: ["development", "test", "preview"],
  razorpay_live: ["production"],
};

const isMode = (v: string): v is PaymentMode => (PAYMENT_MODES as readonly string[]).includes(v);

export function resolvePaymentConfig(env: EnvSource = process.env): PaymentConfig {
  let appEnv: AppEnv;
  try {
    appEnv = resolveAppEnv(env);
  } catch (e) {
    throw new PaymentConfigError([e instanceof EnvSafetyError ? e.message : String(e)]);
  }

  const issues: string[] = [];
  const warnings: string[] = [];
  const keyId = env.RAZORPAY_KEY_ID?.trim() || "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() || "";
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
  const rawMode = env.PAYMENT_MODE?.trim() || "";

  let mode: PaymentMode = "request_only";
  if (!rawMode) {
    if (keyId || keySecret) warnings.push("PAYMENT_MODE is not set, so Razorpay keys are ignored and checkout stays request-only.");
  } else if (isMode(rawMode)) {
    mode = rawMode;
  } else {
    issues.push(`PAYMENT_MODE="${rawMode}" is not one of ${PAYMENT_MODES.join(", ")}.`);
  }

  if (keyId.startsWith("rzp_live_") && appEnv !== "production") {
    issues.push(`Live Razorpay keys must never be configured outside production (APP_ENV=${appEnv}).`);
  }

  if (!ALLOWED_ENVS[mode].includes(appEnv)) {
    issues.push(`PAYMENT_MODE=${mode} is not allowed when APP_ENV=${appEnv} (allowed: ${ALLOWED_ENVS[mode].join(", ")}).`);
  }

  // The mock confirmation key exists only for development/test. Finding it where real customers pay means a
  // misconfigured deployment, so configuration fails closed (build gate, and online payments disabled at runtime).
  const mockKey = env.MOCK_PAYMENT_CONFIRM_KEY?.trim() || "";
  if (mockKey && (appEnv === "preview" || appEnv === "production")) {
    issues.push(`MOCK_PAYMENT_CONFIRM_KEY must not be set when APP_ENV=${appEnv} (it is a development/test-only credential).`);
  } else if (mockKey && mode !== "mock") {
    warnings.push("MOCK_PAYMENT_CONFIRM_KEY is set but PAYMENT_MODE is not mock; it has no effect.");
  }

  if (mode === "razorpay_test" || mode === "razorpay_live") {
    const prefix = mode === "razorpay_test" ? "rzp_test_" : "rzp_live_";
    if (!keyId || !keySecret) issues.push(`PAYMENT_MODE=${mode} requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.`);
    else if (!keyId.startsWith(prefix)) issues.push(`PAYMENT_MODE=${mode} requires a RAZORPAY_KEY_ID starting with "${prefix}".`);
  }

  if (mode === "razorpay_test" || mode === "razorpay_live") {
    if (webhookSecret && webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) issues.push(`RAZORPAY_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`);
    else if (!webhookSecret && mode === "razorpay_live") issues.push("PAYMENT_MODE=razorpay_live requires RAZORPAY_WEBHOOK_SECRET (webhooks are the source of truth for payments).");
    else if (!webhookSecret) warnings.push("RAZORPAY_WEBHOOK_SECRET is not set: the Razorpay webhook endpoint is disabled and payments settle only through checkout verification and reconciliation.");
  } else if (webhookSecret) {
    warnings.push("RAZORPAY_WEBHOOK_SECRET is set but PAYMENT_MODE is not a Razorpay mode; it has no effect.");
  }

  if (mode === "razorpay_live" && env.RAZORPAY_LIVE_ENABLED?.trim() !== "true") {
    issues.push("PAYMENT_MODE=razorpay_live also requires RAZORPAY_LIVE_ENABLED=true (explicit launch switch).");
  }

  if (issues.length) throw new PaymentConfigError(issues);

  const online = mode === "razorpay_test" || mode === "razorpay_live";
  return {
    mode,
    appEnv,
    onlinePayments: online,
    razorpay: online ? { keyId, keySecret, webhookSecret: webhookSecret || null } : null,
    warnings,
  };
}
