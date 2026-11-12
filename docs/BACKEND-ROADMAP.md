# Backend roadmap

Milestones run in order unless dependencies allow overlap. Each task is one `/next` run. Task status lives in `docs/PROGRESS.md`; this file holds scope, acceptance criteria (AC) and the evidence required. A milestone closes only when every AC has evidence and `npm run verify:full` plus CI are green.

Branching: `backend/mN-<slug>` from `backend/development` → verified fast-forward push into `backend/development` (no PRs unless the user asks; see CLAUDE.md Workflow). `main` is promoted only by the user.

---

## M1 — Foundation and safety (done on `backend/m1-foundation`)
| AC | Status | Evidence |
|---|---|---|
| Builds never mutate the DB | PASS | `vercel-build` = `env:check && prisma generate && next build` (package.json); ADR 0001 |
| Migration baseline committed and verified offline | PASS | `prisma/migrations/0_init`; `migrate deploy` + `db:schema:diff` "No difference detected" on throwaway PG16 |
| Invalid signature never mutates; cancelled never paid; idempotent repeat; concurrency safe | PASS | `tests/unit/payment-verification.test.ts` (15), `tests/integration/payment-verify.test.ts` (6); 8 route tests fail on the pre-M1 route |
| Payment mode contract with rejected combinations | PASS | `tests/unit/payment-config.test.ts`; `env:check` rejects `mock` with `VERCEL_ENV=production` |
| Write tests and DB scripts fail closed on non-disposable targets | PASS | `tests/unit/test-safety.test.ts`, `test-environment-route.test.ts`; manual refusal runs recorded in PROGRESS |
| Quality gates and CI | PASS locally / CI unverified until first push | `npm run verify:full` all gates green; `.github/workflows/ci.yml` |
| Frontend unchanged | PASS | no diff under `src/app/**/page.tsx`, `src/components`, `src/styles`, `src/store`, `public` |

---

## M2 — Payment abstraction and order state machine
**Requirements:** one place decides every order/payment transition; pluggable providers (`mock`, `request_only`, `razorpay`) selected by ADR 0002; mock payments recorded and shown as mock and impossible outside dev/test; payment attempts stored; full status history.
**Depends on:** M1.
**Tasks**
- M2-T1 Enum migration: `OrderStatus`, `PaymentStatus`, `PaymentMethod` Prisma enums. Pre-check query for unknown values; `ALTER … USING` cast migration; rehearse on a copy of production data before release.
- M2-T2 `src/lib/orders/state-machine.ts`: transition table plus `transitionOrder({orderId, from, to, actor, reason})` (conditional update and `OrderEvent` insert in one transaction).
- M2-T3 `Payment` model plus `src/lib/payments/providers/{types,request-only,mock,razorpay}.ts`; the existing `payments.ts` becomes a facade.
- M2-T4 Mock flow: `POST /api/payments/mock/confirm` (404 unless the mode is `mock` in development/test); orders and payments carry `mode`; admin and order page label "MOCK — no money moved" (minimal admin and order-page copy needs the user's approval).
- M2-T5 Move `/api/orders` and `/verify` onto providers and the state machine; response shapes unchanged.
- M2-T6 Admin `PATCH /orders/[id]`: only valid transitions (409 otherwise); payment edits require a reason and are recorded as events.

**API/DB:** enums; `Payment(id, orderId, provider, mode, providerOrderId, providerPaymentId @unique, amount, currency, status, createdAt)`; `OrderEvent(id, orderId, from, to, actorType, actorId?, reason?, createdAt)`; `Order.paymentMode`. New mock route; admin PATCH may return 409.
**Tests:** full transition matrix (unit); providers (unit); integration: request → confirm → dispatch, mock → paid, admin invalid transition 409, enum migration on seeded legacy rows; smoke test unchanged.
**AC:** no code writes `Order.status` / `paymentStatus` outside the state machine (grep test in CI); mock impossible in preview/production (tests); existing 41 smoke and 51 UI checks pass; contracts updated.
**Evidence:** `verify:full` output, CI run, migration SQL reviewed, PROGRESS entries.
**Risks/decisions:** How does staff record offline payment for `request_only` orders (UPI/bank transfer, reference field)? Keep COD? Is a combined `payment_pending` customer-facing status wanted?

## M3 — Quantity-aware inventory and transactional orders
**Requirements:** per-variant stock; oversell impossible under concurrency; reservations released on cancel or expiry; idempotent order submission; audited stock adjustments.
**Depends on:** M2 (transitions trigger reserve/release).
**Tasks**
- M3-T1 `Variant.stockQuantity`, `Variant.reserved` (or a reservations table), `InventoryMovement(variantId, delta, reason, orderId?, actor)`; `inStock` becomes derived but stays in API output.
- M3-T2 `createOrder` in one transaction: conditional decrement (`stock - reserved >= qty`), lines, order, event. On failure: 409 naming the item.
- M3-T3 Release on cancel; expiry job for `awaiting_payment` older than N minutes (Vercel Cron → guarded route).
- M3-T4 `Idempotency-Key` header on `POST /api/orders` (stored key + response hash, 24 h).
- M3-T5 Order-number collision retry (unique violation → regenerate, max 3).
- M3-T6 Admin stock adjust endpoint with reason; low-stock list.

**API/DB:** new columns and table; `POST /api/orders` accepts `Idempotency-Key`; `PATCH /api/admin/variants/[id]` gains `stockAdjust {delta, reason}`.
**Tests:** N parallel orders for the last unit → exactly one 201 (integration); idempotent replay returns the same order; cancel releases; expiry releases; movement ledger sums to stock.
**AC:** concurrency test green ×20 runs; no negative stock possible (DB check constraint); response shapes compatible.
**Risks/decisions:** Track real counts or stay manual? Reservation timeout? Allow backorders or pre-orders? Wholesale allocations?

## M4 — Admin identity, authentication, roles and audit
**Requirements:** individual staff accounts; hashed passwords (scrypt/argon2id); revocable DB sessions; roles (`owner`, `operations`, `catalog`, `viewer`); CSRF/Origin protection; audit log of every admin mutation; account lockout.
**Depends on:** M2 (actor on order events).
**Tasks:** M4-T1 `AdminUser`, `AdminSession`, `AuditLog` models · M4-T2 `src/lib/auth/admin.ts` (`requireAdmin(role)`, session rotation, logout revokes) · M4-T3 Origin/CSRF check helper on all admin mutations · M4-T4 guarded bootstrap script for the first owner; retire the shared `ADMIN_PASSWORD` after migration · M4-T5 audit writes in every admin route · M4-T6 minimal admin UI for users and sessions (internal UI; confirm scope).
**API/DB:** new tables; login body `{ email, password }`; 403 for role violations.
**Tests:** role × route matrix; revoked session rejected; cross-origin mutation rejected; audit row per mutation; lockout after N failures.
**AC:** no admin route without `requireAdmin`; logout invalidates server-side; audit completeness test.
**Risks/decisions:** number of staff and roles; 2FA (TOTP) now or later; owner recovery process.

## M5 — Customer accounts, addresses and order history
**Requirements:** sign-in (method to be decided), guest checkout unchanged, saved addresses, order history, claiming past guest orders after verifying phone or email, DPDP Act 2023 consent, export and deletion.
**Depends on:** M2, M4 (session primitives). OTP delivery uses a mock provider until M7.
**Tasks:** M5-T1 `Customer`, `CustomerSession`, `Address`, `OtpChallenge` · M5-T2 OTP issue/verify with rate limits and attempt caps · M5-T3 `/api/account/*` (me, addresses CRUD, orders list/detail) · M5-T4 orders link `customerId` when signed in · M5-T5 guest-order claim · M5-T6 consent record plus delete/export.
**Tests:** OTP brute-force limits; customers see only their own orders (IDOR tests); guest checkout regression; deletion anonymises orders.
**AC:** all account routes covered by authz tests; smoke and UI suites green; no UI changes until M8 approval.
**Risks/decisions:** phone OTP vs email OTP vs password; SMS DLT registration; is an account required for wholesale?

## M6 — Wholesale accounts, pricing, MOQ and quotations
**Requirements:** business account application (from an enquiry or a form) → admin approval; GSTIN capture and format validation; price lists or tiers per account or group; MOQ and case packs per variant; quote request → admin quote → acceptance → order; payment terms (prepaid / credit limit).
**Depends on:** M3, M4, M5; M7 for B2B GST invoices.
**Tasks:** M6-T1 `BusinessAccount`, `PriceList`, `PriceListItem`, `Quote`, `QuoteItem` · M6-T2 price resolution service (account → list → MRP fallback), used by `createOrder` · M6-T3 MOQ validation in cart validate and orders · M6-T4 quote lifecycle state machine · M6-T5 admin approval and pricing endpoints · M6-T6 convert enquiry → account.
**Tests:** price resolution matrix; MOQ rejection; retail customers never see wholesale prices (authz); quote expiry; quote → order totals match.
**AC:** retail flows unchanged; wholesale price leakage tests green.
**Risks/decisions:** pricing model (tiers vs per-account), MOQ values, credit terms, approval criteria, distributor territories.

## M7 — GST, shipping, invoices and notifications
**Requirements:** GST by HSN; tax-inclusive MRP split into CGST+SGST (intra-state, seller in Andhra Pradesh) or IGST; GST snapshot per order line; gap-free invoice numbers per financial year; PDF invoices; pincode serviceability and delivery-fee rules; dispatch tracking; transactional email/SMS through an outbox with retries.
**Depends on:** M2 (events), M3; M6 for B2B invoices.
**Tasks:** M7-T1 `TaxRate(hsnCode, rate, effectiveFrom)` + line tax snapshot · M7-T2 invoice series and `Invoice` model, PDF render · M7-T3 `ShippingRule` / serviceability plus fee calculation in `createOrder` · M7-T4 `Shipment(courier, awb, status)` · M7-T5 `Outbox` plus email provider adapter (mock in dev) · M7-T6 notification templates for order lifecycle events.
**Tests:** tax rounding per line and total (paise exact); intra vs inter-state; invoice numbering under concurrency; outbox retry and idempotency; fee rules.
**AC:** a CA-reviewed tax fixture set passes; invoices regenerate identically; no notification sent from dev/test to real recipients.
**Risks/decisions:** GSTIN and registered address, GST rates per HSN (CA sign-off), e-invoicing (IRN) applicability, courier partner, email/SMS/WhatsApp providers, free-shipping threshold.

## M8 — Frontend/backend integration and end-to-end testing
**Requirements:** wire new capabilities (accounts, wholesale, mock/request/online payment states, invoices, tracking) into the UI with minimal, approved changes; robust E2E suite.
**Depends on:** M2–M7; UI designs approved by the user.
**Tasks:** M8-T1 checkout messaging for 409/503 and payment states · M8-T2 account pages · M8-T3 wholesale portal · M8-T4 order page shows invoice and tracking · M8-T5 move `e2e-ui.mjs` into the `@playwright/test` runner in CI · M8-T6 contract tests for every route in `API-CONTRACTS.md`.
**Tests:** E2E for guest, account, wholesale and admin journeys on a disposable DB; visual regression on existing pages.
**AC:** existing pages are visually unchanged (snapshot diff); all journeys green in CI.
**Risks/decisions:** design approval for new pages; scope of the visual regression baseline.

## M9 — Production hardening and release readiness
**Requirements:** safe production database operations, isolation, observability, recoverability, security headers.
**Depends on:** M1; must finish before M10 goes live.
**Tasks:** M9-T1 production baselining per `RUNBOOK-DATABASE.md` (operator plus agent checklist) · M9-T2 verify and enforce preview DB isolation (a Neon branch per preview, or previews disabled) · M9-T3 CSP, HSTS, frame-ancestors, Referrer-Policy · M9-T4 shared rate limiter (Postgres or Upstash) · M9-T5 structured logging plus error monitoring; uptime checks · M9-T6 ESLint (`eslint-config-next`) in CI · M9-T7 backup and restore drill with documented RPO/RTO · M9-T8 branch protection on `main` and `backend/development`, required CI · M9-T9 dependency audit (dev `postcss`/`esbuild` advisories) · M9-T10 release checklist and rollback plan.
**Tests:** header assertions; limiter across instances; restore drill evidence.
**AC:** production baselined with zero drift; restore drill completed; security headers scored; CI required on protected branches.
**Risks/decisions:** monitoring vendor; RPO/RTO targets; custom domain timing.

## M10 — Razorpay webhooks, reconciliation, refunds and launch
**Requirements:** verified webhooks as the source of truth; deduplicated event processing; reconciliation of stuck `awaiting_payment` orders; amount and currency checks; admin refunds (full/partial); test-mode end-to-end; gated live launch.
**Depends on:** M2, M4, M7, M9.
**Tasks:** M10-T1 `POST /api/payments/razorpay/webhook` (raw-body HMAC with the webhook secret, `WebhookEvent` dedupe table) · M10-T2 handlers: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed` via the state machine · M10-T3 reconciliation cron (fetch payments for stale orders) · M10-T4 refund service plus admin endpoint · M10-T5 amount/currency verification against the order · M10-T6 test-mode E2E with Razorpay test keys in a preview with an isolated DB · M10-T7 live checklist (KYC, live keys, `RAZORPAY_LIVE_ENABLED`, monitoring, rollback to `request_only`).
**Tests:** forged webhook rejected; duplicate events idempotent; out-of-order events; partial refunds; reconciliation fixes a dropped-browser case.
**AC:** a dropped-browser payment ends `paid` within one reconciliation cycle; refund ledger matches the gateway; live switch is reversible by config alone.
**Risks/decisions:** auto-capture setting, refund policy and approvals, whether COD stays after launch, settlement reconciliation owner.
