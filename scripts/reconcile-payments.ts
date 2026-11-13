/**
 * Operator tool: one reconciliation cycle (docs/RUNBOOK-DATABASE.md, ADR 0009, ADR 0018): stale awaiting-payment
 * orders, attempts with an unknown outcome, pending refunds. Same code as the scheduled route.
 *   npm run payments:reconcile            (guarded by scripts/db-guard.ts; production needs the explicit confirmation)
 *   npm run payments:reconcile -- --audit-refunds [--days=14]   also compare the refund ledger with the gateway
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
  const { reconcileGateway, auditRefunds } = await import("../src/lib/payments/reconcile");
  console.log("[reconcile]", JSON.stringify(await reconcileGateway(config)));
  if (process.argv.includes("--audit-refunds")) {
    const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7));
    console.log("[reconcile] refund audit", JSON.stringify(await auditRefunds(config, { days: Number.isFinite(days) && days > 0 ? days : undefined })));
  }
}
main().catch((e) => {
  console.error(`[reconcile] ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
});
