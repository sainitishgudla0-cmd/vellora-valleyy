# ADR 0024 — Offline payment collections are a dedicated, attested, immutable record

- **Status:** accepted (M11 P1-T2, finding F04), 2026-11-20. Policy parts are provisional until the business decides (below).
- **Context:** marking a pay-on-delivery order paid (or a cash return refunded) was an `orders:write` status edit open to operations accounts and, until P1-T5, the shared password. It required a reason and a unique reference but no amount or method, so it was possible to "confirm" a payment that never matched the order, and the record could later be edited directly.

## Decision
- New permission **`payments:record`**. Every `paymentStatus` change on `PATCH /api/admin/orders/[id]` needs it in addition to `orders:write`. **Only owners hold it** until the business decides who may record collections (the most restrictive choice; granting it to operations is a one-line change in `ROLE_PERMISSIONS` plus `auth-core.test.ts`). The shared-password session can never hold it (ADR 0022 allow-list).
- **Attestation:** `offline: { amountPaise, method }` is required; the amount must equal the payment amount exactly (partial collections and partial cash returns are not recorded through this path); `method` ∈ cash, upi, bank_transfer, cheque, card_on_delivery.
- **Record:** `Payment.manualMethod`, `manualRecordedBy` (admin id), `manualRecordedAt` next to the unique `manualReference`; the event and the in-transaction audit row (ADR 0021) carry the method and amount. Additive migration `20261120083137_offline_payment_record` with CHECKs (request-only only; a method needs a reference) and a trigger that refuses changing or clearing a recorded collection.
- **Disabled (policy-dependent):** offline refunds of gateway (Razorpay) payments stay refused (`409 payment_edit_not_allowed`, ADR 0019); partial offline collections; payment edits on legacy (mode NULL) orders.

## Open business decisions
Who besides owners may record collections and cash returns; whether partial collections/advances exist; whether an offline refund of an online payment is ever allowed (and with what evidence).

## Evidence
`tests/integration/offline-payments.test.ts` (8: role matrix incl. shared session, attestation, concurrent duplicate reference → one wins, trigger immutability incl. direct DB updates, DB CHECKs, owner-only full cash return, gateway offline refund refused), updated `admin-orders`, `audit-critical`, `notifications`, `auth-core`; Playwright `admin-operations.spec.ts` records a UPI collection through the form. Against the pre-change code 5 of the 8 new tests fail.
