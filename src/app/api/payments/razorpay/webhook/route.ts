import { NextResponse } from "next/server";
import { safePaymentConfig } from "@/lib/payments";
import { EVENT_ID_HEADER, handleRazorpayWebhook, MAX_WEBHOOK_BYTES, SIGNATURE_HEADER } from "@/lib/payments/webhook";

export const dynamic = "force-dynamic";

/**
 * Razorpay webhook receiver (M10-T1). Machine-to-machine: no cookies, no CORS, no rate limit (the HMAC over the raw
 * body is the authentication; an unsigned request does no work beyond one hash). Contract: docs/API-CONTRACTS.md.
 * The body is read as TEXT because the signature covers the exact bytes the gateway sent.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  const rawBody = await req.text();
  const res = await handleRazorpayWebhook({ rawBody, signature: req.headers.get(SIGNATURE_HEADER), eventId: req.headers.get(EVENT_ID_HEADER) }, safePaymentConfig());
  return NextResponse.json(res.body, { status: res.status, headers: { "Cache-Control": "no-store" } });
}
