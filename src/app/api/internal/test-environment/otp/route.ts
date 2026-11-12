import { fail, json } from "@/lib/api";
import { resolveAppEnv } from "@/lib/env/app-env";
import { resolveOtpConfig } from "@/lib/env/otp-config";
import { assertDisposableDatabase, assertTestTargetDeclared } from "@/lib/env/test-safety";
import { mockOtpOutbox } from "@/lib/auth/otp-sender";

export const dynamic = "force-dynamic";

/**
 * Browser tests cannot read an email, so on a server that proves it is a disposable test/development instance in
 * CUSTOMER_OTP_MODE=mock they can ask for the newest mock "sent" code (docs/API-CONTRACTS.md#test-environment). Everywhere else this
 * route does not exist (404): production and preview, a server without the mock sender (which those environments cannot have),
 * and any server whose database is not declared disposable.
 */
export async function GET(req: Request) {
  const NOT_FOUND = () => fail("Not found", 404);
  try {
    const appEnv = resolveAppEnv();
    if (appEnv !== "development" && appEnv !== "test") return NOT_FOUND();
    if (resolveOtpConfig().mode !== "mock") return NOT_FOUND();
    assertTestTargetDeclared();
    assertDisposableDatabase(process.env, "mock OTP lookup");
  } catch {
    return NOT_FOUND();
  }
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  const entry = [...mockOtpOutbox].reverse().find((o) => o.email === email);
  return entry ? json({ code: entry.code }) : NOT_FOUND();
}
