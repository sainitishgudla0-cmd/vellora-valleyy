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

## 2. Shared admin password retired from anything that matters (P1-T5, F05)
**Context.** The M4 transition login (`ADMIN_PASSWORD`, no email) produced an "owner minus `users:manage`/`refunds:write`" session: one password shared by everyone, unattributable, yet able to confirm payments, change order state, prices, stock, tax rates, invoices and delete test data. It was on wherever `ADMIN_PASSWORD` was set, production included.

**Decision.**
- **Allow-list:** the shared-password session holds only `admin:read`, `enquiries:write`, `wholesale:read`, `fulfilment:read` (`LEGACY_SESSION_PERMISSIONS`, `src/lib/auth/roles.ts`). Every other permission needs an individual account; the routes answer `403` (and audit `access.denied`).
- **Never in production:** `legacyLoginEnabled()` is false when the resolved environment is production, or when it cannot be resolved (fail closed), whatever `ADMIN_PASSWORD`/`ADMIN_LEGACY_LOGIN` say. Live shared-password sessions die on their next request (existing behaviour of `loadSession`).
- **`env:check`:** `ADMIN_LEGACY_LOGIN` may only be unset or `off` (it can switch the login off, never force it on); warnings for a leftover `ADMIN_PASSWORD` in production and an enabled shared login in preview.
- **Owner recovery:** `admin:bootstrap --reset` calls `recoverOwner()`: one transaction under a row lock sets the password, reactivates and unlocks the owner, revokes all of that owner's sessions **and all shared-password sessions**, and writes `owner.recover` with `writeAuditTx` (critical class, ADR 0021). Previously three separate writes with a best-effort `owner.password_reset` row. Operator procedure: `RELEASE.md` A1b.
- **Verification harness:** `verify:full` creates its throwaway owner (`--additional-owner`, disposable DB only) before the API smoke test; the smoke test makes its admin price edit as that owner, and with only the shared password asserts the edit is refused.

**Consequences.** Promotion to production requires an owner account to exist first (`RELEASE.md` A1). Non-production staff who used the shared password for operations need individual accounts (an owner creates them in Team). 2FA remains open (not built).

**Evidence.** `tests/integration/legacy-admin.test.ts` (route matrix for the shared session; production and unresolvable environments refuse login and kill live sessions; owner accounts unaffected; recovery revokes owner + shared sessions, refuses non-owners/weak passwords, rolls back on audit failure), `tests/unit/{auth-core,security-config}.test.ts`, `admin-users.test.ts` (the real script, `owner.recover` row).
