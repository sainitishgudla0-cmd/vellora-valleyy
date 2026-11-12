/**
 * Build-time configuration gate (runs first in `vercel-build` and CI). Never prints secrets.
 * Fails the build when the payment configuration is unsafe for the resolved environment.
 */
import { resolvePaymentConfig, PaymentConfigError } from "../src/lib/env/payment-config";
import { NotifyConfigError, resolveNotifyConfig } from "../src/lib/env/notify-config";
import { OtpConfigError, resolveOtpConfig } from "../src/lib/env/otp-config";
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

try {
  const otp = resolveOtpConfig();
  for (const w of otp.warnings) console.warn(`[check-env] warning: ${w}`);
  console.log(`[check-env] CUSTOMER_OTP_MODE=${otp.mode}`);
} catch (e) {
  console.error(`[check-env] ${e instanceof OtpConfigError ? e.issues.join("\n[check-env] ") : e}`);
  process.exit(1);
}

try {
  const n = resolveNotifyConfig();
  for (const w of n.warnings) console.warn(`[check-env] warning: ${w}`);
  console.log(`[check-env] NOTIFY_MODE=${n.mode}`);
} catch (e) {
  console.error(`[check-env] ${e instanceof NotifyConfigError ? e.issues.join("\n[check-env] ") : e}`);
  process.exit(1);
}
