/**
 * Same-origin check for state-changing admin requests (M4-T3, ADR 0012). Pure.
 * Browsers always send `Origin` on cross-site POST/PATCH/PUT/DELETE, so a mismatch means a page on another site is
 * driving the admin's cookie. A request with no Origin comes from a non-browser client (script, curl, test), which
 * would need the session cookie itself to do harm; `Sec-Fetch-Site` is honoured when present.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isMutation = (method: string) => !SAFE_METHODS.has(method.toUpperCase());

export function isSameOrigin(headers: Headers, method: string, extraAllowedOrigins: readonly string[] = []): boolean {
  if (!isMutation(method)) return true;
  const origin = headers.get("origin");
  if (origin) {
    if (extraAllowedOrigins.includes(origin)) return true;
    const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
    try {
      return !!host && new URL(origin).host === host;
    } catch {
      return false; // "null" or garbage
    }
  }
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

export function allowedOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ADMIN_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
