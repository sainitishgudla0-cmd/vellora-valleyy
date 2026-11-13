---
paths:
  - "src/lib/payments.ts"
  - "src/lib/payments/**"
  - "src/lib/payment-*.ts"
  - "src/lib/env/payment-config.ts"
  - "src/app/api/payments/**"
  - "src/app/api/orders/**"
  - "src/components/forms/CheckoutForm.tsx"
---
# Payment rules

- Modes and allowed environments are defined only in `src/lib/env/payment-config.ts` (ADR 0002). Don't add mode checks elsewhere; consume `safePaymentConfig()` / `onlinePaymentsEnabled()`.
- An order becomes `paid` only from a verified gateway signal (signature or verified webhook), via a conditional update from `awaiting_payment`. Invalid or unverifiable input never mutates payment state.
- Mock payments must be labelled as mock wherever they are stored or shown, and must be impossible in preview/production.
- Never log full payment payloads, signatures, key secrets or card/UPI data. Log the order number and reason only.
- Live keys (`rzp_live_`) are never used outside production; tests use fake `rzp_test_` values and locally computed HMACs.
- Any change here needs regression tests in `tests/unit/payment-*.test.ts` and, for state transitions, `tests/integration/`.

- Amounts and prices are GST-inclusive integer paise; tax is carved out per line (`src/lib/tax/calc.ts`), never with floating point. GST rates are data (`TaxRate`), never hard-coded; a missing rate or seller GSTIN refuses the invoice rather than guessing.

- Webhooks (M10): `POST /api/payments/razorpay/webhook` verifies the HMAC of the **raw** body before parsing or writing anything and dedupes on `WebhookEvent`; webhook, `/verify` and reconciliation all end in `applyGatewayPayment` (one conditional-write path). A captured payment that does not match its order (amount, currency, cancelled, already paid) is never applied: record it as an orphan capture (`recordOrphanCapture`), never mark the order paid and never drop it.
- Refunds (M10): only through `src/lib/payments/refunds.ts` (ledger row committed under a row lock **before** the gateway call, row id as `receipt`, never retried on an unknown outcome). The `Refund` ledger is written only by `refunds.ts` and `reconcile.ts` (ratchet test `refund-ledger-ratchet`); `refunds:write` is owner accounts only; admin audit gets ids and codes, never the reason text.
