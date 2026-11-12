import { NextResponse } from "next/server";
import { fail, json, parseBody } from "@/lib/api";
import { customerAuthConfigured, requireCustomerSameOrigin } from "@/lib/auth/customer";
import { issueOtp } from "@/lib/auth/otp";
import { otpRequestSchema } from "@/lib/account/schemas";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Sends a sign-in code. The answer never depends on whether the address has an account (202 either way). 503 while no
 * real sender is configured (M7), 429 for the per-IP, per-address and resend limits.
 */
export async function POST(req: Request) {
  const cross = requireCustomerSameOrigin(req);
  if (cross) return cross;
  if (!customerAuthConfigured()) return fail("Sign-in is not available right now.", 503);
  if (!(await rateLimit("account-otp-request", 10, 15 * 60_000))) return fail("Too many attempts. Please try again later.", 429);
  const parsed = await parseBody(req, otpRequestSchema);
  if ("response" in parsed) return parsed.response;
  const r = await issueOtp(parsed.data.email);
  if (r.ok) return json({ ok: true, message: "If the address is valid, a sign-in code is on its way." }, 202);
  if (r.reason === "unavailable") return fail("Sign-in by email is not available yet.", 503);
  return NextResponse.json({ error: "Please wait before asking for another code." }, { status: 429, headers: { "Retry-After": String(r.retryAfterS ?? 60) } });
}
