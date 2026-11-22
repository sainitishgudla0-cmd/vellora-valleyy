/**
 * The client address used to key rate limits (M12 VA-08). Pure.
 *
 * `X-Forwarded-For` is a list each proxy APPENDS to, so only the entries added by proxies we trust are facts; anything
 * before them was written by the client. The previous code used the FIRST entry, which is correct on Vercel (Vercel
 * overwrites the header and does not forward a client's value) but lets a client pick a fresh key per request anywhere
 * else (a Render service, `next start` behind nginx), defeating the sign-in-code and admin-login limits.
 *
 *  - On Vercel (`VERCEL=1`): `X-Real-IP` / the first `X-Forwarded-For` entry, both set by Vercel itself.
 *  - Elsewhere: `TRUSTED_PROXY_HOPS` (default 1) proxies in front of the app; the client is the entry that many places
 *    from the right. With fewer entries than trusted hops the request did not come through the proxies: every such
 *    request shares one "untrusted" key (strict, never bypassable). `TRUSTED_PROXY_HOPS=0` means no proxy: the headers
 *    are ignored and all requests share the "direct" key.
 * `X-Real-IP` is ignored off Vercel because a client can send it.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const chain = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.VERCEL === "1") return headers.get("x-real-ip")?.trim() || chain[0] || "unknown";
  const hops = trustedHops(env.TRUSTED_PROXY_HOPS);
  if (hops === 0) return "direct";
  if (chain.length === 0) return "local";
  return chain.length >= hops ? chain[chain.length - hops] : "untrusted";
}

function trustedHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}
