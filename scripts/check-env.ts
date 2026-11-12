/**
 * Build-time configuration gate (runs first in `vercel-build` and CI). Never prints secrets.
 * Fails the build when the payment configuration is unsafe for the resolved environment.
 */
import { resolvePaymentConfig, PaymentConfigError } from "../src/lib/env/payment-config";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
try {
  const cfg = resolvePaymentConfig();
  for (const w of cfg.warnings) console.warn(`[check-env] warning: ${w}`);
  console.log(`[check-env] APP_ENV=${cfg.appEnv} PAYMENT_MODE=${cfg.mode} onlinePayments=${cfg.onlinePayments}`);
} catch (e) {
  console.error(`[check-env] ${e instanceof PaymentConfigError ? e.issues.join("\n[check-env] ") : e}`);
  process.exit(1);
}
