import { fail, json } from "@/lib/api";
import { safeEqual } from "@/lib/payment-verification";
import { processOutbox } from "@/lib/notify/dispatch";

export const dynamic = "force-dynamic";

/**
 * Scheduled job: sends queued notifications (Vercel Cron GET with `Authorization: Bearer $CRON_SECRET`). 404 unless CRON_SECRET is
 * 24+ characters, 401 for a wrong bearer. Counts only. Does nothing unless a provider is configured (NOTIFY_MODE; never in production yet).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (secret.length < 24) return fail("Not found", 404);
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return fail("Unauthorized", 401);
  return json({ ok: true, ...(await processOutbox()) });
}
