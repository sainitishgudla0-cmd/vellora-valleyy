# ADR 0022 — Fail-closed rate limits; retiring the shared admin password

- **Status:** accepted (M11 P1-T6 F08; P1-T5 F05), 2026-11-20

## 1. Rate limiter fail mode (P1-T6, F08)
**Context.** `consume()` (M9-T4) fell back to a per-instance `Map` for every caller when Postgres failed. On Vercel each instance then admits the full limit, so a store outage silently multiplied the sign-in, one-time-code and payment-verification limits by the number of instances.

**Decision.**
- `consume(client, key, limit, windowMs, failMode)`: `closed` (default) refuses when the shared store fails; `open` keeps the per-instance fallback.
- The fail mode is chosen per bucket in one table, `RATE_LIMIT_POLICY` (`src/lib/rate-limit.ts`). Closed: `admin-login`, `admin-password`, `account-otp-request`, `account-otp-verify`, `account-claim`, `account-export`, `payment-verify`, `mock-confirm`, `orders`, `business-orders`, `business-quote`, `business-quote-accept`, `business-apply`. Open: `shipping-quote`, `order-invoice` (needs the order's random access token), `enquiries`, `newsletter`. An unlisted bucket is closed.
- Routes keep their contract: a refused request is the existing `429`. During a database outage those routes would fail anyway; the change matters when only the limiter table or its queries fail.
- `env:check` refuses `RATE_LIMIT_STORE=memory` in preview/production and any unknown value everywhere (`src/lib/env/security-config.ts`).
- Admin routes other than login/password have no IP limiter: they need a session and a role, and refunds are additionally owner-only, idempotent and row-locked.

**Evidence.** `tests/unit/rate-limit-policy.test.ts` (every bucket used under `src/app` is listed; sensitive ones closed; unknown closed; env gate) and `tests/integration/rate-limit-fail-closed.test.ts` (trigger-injected store failure: admin sign-in with the right password, OTP request and order placement → 429 with nothing written; delivery quote → 200). On the pre-change limiter the three sensitive cases fail.
