import { NextResponse } from "next/server";
import { fail, parseBody } from "@/lib/api";
import { cookieOptions, CUSTOMER_COOKIE, customerAuthConfigured, customerFromRequest, requireCustomerSameOrigin, revokeCustomerSession } from "@/lib/auth/customer";
import { verifyOtp } from "@/lib/auth/otp";
import { otpVerifySchema } from "@/lib/account/schemas";
import { rateLimit } from "@/lib/rate-limit";

/** Exchanges the emailed code for a session cookie. First sign-in for an address needs `acceptTerms: true` (creates the account). */
export async function POST(req: Request) {
  const cross = requireCustomerSameOrigin(req);
  if (cross) return cross;
  if (!customerAuthConfigured()) return fail("Sign-in is not available right now.", 503);
  if (!(await rateLimit("account-otp-verify", 20, 15 * 60_000))) return fail("Too many attempts. Please try again later.", 429);
  const parsed = await parseBody(req, otpVerifySchema);
  if ("response" in parsed) return parsed.response;
  const r = await verifyOtp({ ...parsed.data, userAgent: req.headers.get("user-agent") });
  if (!r.ok) {
    if (r.reason === "terms_required") return NextResponse.json({ error: "Please accept the terms and privacy notice to create your account.", code: "terms_required" }, { status: 409 });
    return fail("That code is incorrect or has expired.", 401);
  }
  const previous = await customerFromRequest(req); // a new sign-in replaces the session the browser held
  if (previous) await revokeCustomerSession(previous.sessionId);
  const res = NextResponse.json({ ok: true, created: r.created });
  res.cookies.set(CUSTOMER_COOKIE, r.token, cookieOptions());
  return res;
}
