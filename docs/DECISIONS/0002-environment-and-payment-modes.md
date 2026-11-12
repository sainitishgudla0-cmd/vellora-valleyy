# ADR 0002 — Environment identity and payment modes

- **Status:** accepted (M1, 2026-11-11). Implemented in `src/lib/env/app-env.ts`, `src/lib/env/payment-config.ts`.
- **Context:** Online payment switched on whenever Razorpay keys existed. Nothing separated development from production, there was no mock provider, and live keys could be used anywhere.
- **Decision:**
  - **Environment** (`resolveAppEnv`): on Vercel, `VERCEL_ENV` is authoritative and `APP_ENV` must match it (a deployment can't claim to be test). Off Vercel, `APP_ENV`, then `NODE_ENV`. An unlabelled `NODE_ENV=production` resolves to production (fail closed).
  - **`PAYMENT_MODE`** (unset → `request_only`):

    | mode | allowed in | requirements | gateway |
    |---|---|---|---|
    | `mock` | development, test | — | none (M2 adds a labelled mock provider) |
    | `request_only` | all | — | none: order request, payment pending |
    | `razorpay_test` | development, test, preview | `rzp_test_` id + secret | Razorpay test |
    | `razorpay_live` | production | `rzp_live_` id + secret + `RAZORPAY_LIVE_ENABLED=true` | Razorpay live |

  - `rzp_live_` keys outside production are rejected in every mode.
  - Invalid config **fails the build** (`npm run env:check` in `vercel-build` and CI) and, at runtime, disables online payment (`safePaymentConfig()` returns null and logs once) and makes `/verify` answer 503 without writes.
- **Consequences:** Production behaviour is unchanged (no `PAYMENT_MODE` → request-only; keys present without a mode are ignored with a warning). `mock` is accepted but behaves like `request_only` until M2 builds the provider abstraction.
