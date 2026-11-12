# ADR 0007 — Payment providers and payment attempts

- **Status:** accepted (M2-T3, 2026-11-11)
- **Decision:**
  - `src/lib/payments/providers/{types,request-only,mock,razorpay,index}.ts`. `PaymentProvider` = `{id, mode, online, label, createPayment(req) → ProviderPayment|null, verifyPayment(proof) → boolean}`. `providerForConfig(config)` picks by `PAYMENT_MODE` only; environment rules stay in `resolvePaymentConfig` (ADR 0002).
  - **request_only** takes no payment at order time and `verifyPayment` is always `false`: nothing can confirm a payment through it, so there is still no automatic offline-payment confirmation. Staff reference capture and audited confirmation are M2-T6.
  - **mock** has no network access, carries the label `MOCK — no money moved`, and its factory throws unless `mode=mock` and `appEnv` is development/test, a second barrier behind the config check. Its proofs are HMACs with a non-secret constant (the mock is unreachable in preview/production).
  - **razorpay** is the former `payments.ts` code, unchanged in behaviour (same request, same HMAC, constant-time compare). The client payload keeps the existing `{provider, keyId, orderId, amount, currency}` shape and never contains the secret.
  - `src/lib/payments.ts` stays the facade (`safePaymentConfig`, `razorpayConfig`, `onlinePaymentsEnabled`, `createRazorpayOrder`, `verifyRazorpaySignature` unchanged; adds `currentPaymentProvider()`). Routes are not touched until M2-T5.
  - **`Payment`** table (additive migration `payment_attempts`): `orderId` (cascade), `provider` and `mode` enums (`PaymentProvider`, `PaymentMode` = the four `PAYMENT_MODES`), `providerOrderId`, `providerPaymentId @unique`, `amount` (paise), `currency`, `status` (`PaymentStatus`). `recordPaymentAttempt` inserts unpaid attempts only. `Order.paymentMode` and any status change on payments are done in M2-T4/T5 via the state machine.
- **Consequences:** every attempt records which provider and mode produced it, so mock rows are always identifiable. No route behaviour changed in this task.
