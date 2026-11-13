/**
 * Security response headers (M9-T3, ADR 0017). Plain ESM so next.config.mjs and unit tests can both import it.
 *
 * CSP notes:
 * - `script-src 'unsafe-inline'` is required today: Next.js streams inline hydration scripts and the root layout
 *   has two inline scripts. A nonce-based policy needs every page rendered dynamically; that is a performance and
 *   frontend change that needs approval (recorded as a follow-up in ADR 0017). Everything else is locked down.
 * - Razorpay Checkout (checkout.razorpay.com script, api.razorpay.com frame and XHR) is the only third-party origin.
 * - `unsafe-eval` is added only for `next dev` (React refresh).
 */

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com";
const RAZORPAY_FRAME = ["https://api.razorpay.com", "https://checkout.razorpay.com"];
const RAZORPAY_CONNECT = ["https://api.razorpay.com", "https://lumberjack.razorpay.com", "https://checkout.razorpay.com"];

export function contentSecurityPolicy({ dev = false } = {}) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", RAZORPAY_SCRIPT, ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...RAZORPAY_CONNECT, ...(dev ? ["ws:", "wss:"] : [])],
    "frame-src": RAZORPAY_FRAME,
    "media-src": ["'self'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function securityHeaders({ dev = false } = {}) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev }) },
    // two years, no includeSubDomains and no preload: those are irreversible-ish and need the domain decision (ADR 0017)
    { key: "Strict-Transport-Security", value: "max-age=63072000" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // payment (Razorpay) is delegated to its own frame; everything else off
    { key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com"), usb=(), interest-cohort=()' },
    { key: "X-DNS-Prefetch-Control", value: "on" },
  ];
}
