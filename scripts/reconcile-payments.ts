/**
 * Operator tool: resolve Razorpay attempts with an unknown outcome (docs/RUNBOOK-DATABASE.md, ADR 0009).
 *   npm run payments:reconcile            (guarded by scripts/db-guard.ts; production needs the explicit confirmation)
 * Uses the configured PAYMENT_MODE credentials; does nothing in other modes. Prints counts only, no payment data.
 */
import { resolvePaymentConfig } from "../src/lib/env/payment-config";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
async function main() {
  const config = resolvePaymentConfig();
  if (config.mode !== "razorpay_test" && config.mode !== "razorpay_live") {
    console.log(`[reconcile] PAYMENT_MODE=${config.mode}: nothing to reconcile.`);
    return;
  }
  const { reconcilePendingPayments } = await import("../src/lib/payments/reconcile");
  console.log("[reconcile]", JSON.stringify(await reconcilePendingPayments(config)));
}
main().catch((e) => {
  console.error(`[reconcile] ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
});
