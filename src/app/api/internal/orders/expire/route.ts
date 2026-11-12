import { fail, json } from "@/lib/api";
import { safeEqual } from "@/lib/payment-verification";
import { safePaymentConfig } from "@/lib/payments";
import { expireUnpaidOrders } from "@/lib/orders/expire";

export const dynamic = "force-dynamic";

const MIN_SECRET_LENGTH = 24;

/**
 * Scheduled job (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`): cancels unpaid online orders
 * past the payment window so their reserved stock is released. The route does not exist (404) unless CRON_SECRET
 * is configured with 24+ characters; a wrong or missing bearer is 401. Returns counts only. Contract: docs/API-CONTRACTS.md.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return fail("Not found", 404);
  const given = req.headers.get("authorization") ?? "";
  if (!safeEqual(given, `Bearer ${secret}`)) return fail("Unauthorized", 401);
  const config = safePaymentConfig();
  if (!config) return fail("Payments are misconfigured", 503);
  const minutes = Number(process.env.PAYMENT_WINDOW_MINUTES);
  return json({ ok: true, ...(await expireUnpaidOrders(config, { windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined })) });
}
