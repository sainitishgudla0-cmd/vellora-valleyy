import { fail, json } from "@/lib/api";
import { safeEqual } from "@/lib/payment-verification";
import { safePaymentConfig } from "@/lib/payments";
import { reconcileGateway } from "@/lib/payments/reconcile";

export const dynamic = "force-dynamic";

const MIN_SECRET_LENGTH = 24;

/**
 * Scheduled reconciliation (M10-T3), same protection as the order-expiry job: 404 unless CRON_SECRET is 24+ chars,
 * 401 on a wrong bearer. Asks the gateway about stale awaiting-payment orders and pending refunds and applies what
 * it finds through the same conditional code as the webhook. Returns counts only. Contract: docs/API-CONTRACTS.md.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return fail("Not found", 404);
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return fail("Unauthorized", 401);
  const config = safePaymentConfig();
  if (!config) return fail("Payments are misconfigured", 503);
  return json({ ok: true, mode: config.mode, ...(await reconcileGateway(config)) });
}
