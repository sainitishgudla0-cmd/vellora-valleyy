import { NextResponse } from "next/server";
import { CUSTOMER_COOKIE, customerFromRequest, requireCustomerSameOrigin, revokeAllCustomerSessions, revokeCustomerSession } from "@/lib/auth/customer";

/** Ends this session server-side (or all of them with `{ "everywhere": true }`), then clears the cookie. Always 200. */
export async function POST(req: Request) {
  const cross = requireCustomerSameOrigin(req);
  if (cross) return cross;
  const me = await customerFromRequest(req);
  if (me) {
    const everywhere = ((await req.json().catch(() => ({}))) as { everywhere?: unknown }).everywhere === true;
    if (everywhere) await revokeAllCustomerSessions(me.customerId);
    else await revokeCustomerSession(me.sessionId);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(CUSTOMER_COOKIE);
  return res;
}
