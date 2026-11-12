# Progress

_Read this first in a new session. Keep it under ~80 lines. Scope and AC per task: `BACKEND-ROADMAP.md`._

## Current
- **Milestone:** M2 in progress on `backend/m2-payments`. **M2 complete (T1..T6)**, awaiting user review. M3 needs approval.
- **Branch:** M1 is integrated: `backend/development` = see the M2-T5 entry below (fast-forwarded from `backend/m2-payments`; no PR workflow). Working copy moved to `~/Developer/Velora-Valley` (the Desktop copy is iCloud-synced and spawns duplicate files). `main` = `55aa848`, untouched.
- **Last verified:** 2026-11-11, `npm run verify:full` on throwaway Postgres 16 (127.0.0.1): all gates green. See the M1 evidence below.

## Next up
| Task | Status | Notes |
|---|---|---|
| M3 inventory/stock reservation + order idempotency | proposed (needs approval) | M2 is complete; see `BACKEND-ROADMAP.md` M3 |

## Blockers / open items
1. **Preview DB isolation unverified.** Vercel project settings weren't accessible (local CLI account can't see the production team; Vercel MCP unauthorised). GitHub shows no Vercel deployments or statuses for this repo, so previews don't appear to be Git-triggered. M1 builds are DB-write-free regardless; reads during a preview build would still use whatever `DATABASE_URL` preview has. Owner: user (Vercel dashboard).
2. **Production not baselined** onto Prisma Migrate (`docs/RUNBOOK-DATABASE.md`). Operator task, planned in M9-T1 or before the first production migration.
3. (resolved) CI green on `backend/development` @ `38b476e`.
4. Dev-dependency advisories: `postcss` (high), `esbuild` via `tsx` (moderate). Prod deps clean. Tracked as M9-T9.
5. (resolved 2026-11-12) iCloud sync duplicates ("<name> 2.ext") in `~/Desktop/Velora Valley`; repo relocated to `~/Developer/Velora-Valley`. Stage files by explicit path only (never `git add .` / `git add docs`).
6. Local Node is 20.19.6; project targets 24 (`.nvmrc`, CI uses 24).

## Done
### M2-T6 — admin order/payment changes through the state machine (ADR 0010)
- `PATCH /api/admin/orders/[id]` → `updateOrderAsAdmin` → `transitionOrder` (actor admin): invalid transitions 409, reason/reference 422, admin can never set an order `paid`. Manual payment confirmation only for request-only orders (payment-only, reason + external reference stored on `Payment.manualReference` (unique) and the event); `paid → refunded` bookkeeping with reason; gateway/mock/legacy payments not editable. Payment row + order + event in one transaction. State machine: admin may confirm a payment only with a valid reference, payment-only. Additive migration `manual_payment_confirmation`. Direct-writer ratchet legacy list is now empty. No frontend change (dropdown unchanged; no UI yet for entering a reference — needs approval).
- Tests: `integration/admin-orders.test.ts` (25: transitions, invalid 409, no-paid-by-admin, default/explicit reasons, manual confirm incl. reference reuse rollback, refused for razorpay/mock/legacy/no-record/cancelled, refund bookkeeping, race, trigger-injected rollback, DB CHECK), state-machine unit additions, PATCH boundary unit tests rewritten.
- **Evidence (2026-11-12, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 231/231 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 147/147 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓; `npm audit --omit=dev` 0.
- M2 acceptance (roadmap): no application code writes `Order.status`/`paymentStatus` outside the state machine (ratchet test, empty legacy list); mock impossible in preview/production (tests, ADR 0002/0008); 41 smoke + 51 UI pass; contracts updated.
- Open for later: admin UI for payment references; per-person admin identity (M4); order idempotency + stock (M3); webhooks/refunds (M10).
### M2-T5 — order/payment integration (ADR 0009)
- `createOrder` inserts order + `Payment` attempt atomically (COD → `request_only`; mock → mock attempt; Razorpay → pending attempt). `/api/orders` uses `startOnlinePayment`: gateway call outside any transaction; definite failure → cancel via `transitionOrder`; unknown outcome → keep `awaiting_payment`, flag `needsReconciliation`, 502 + order number. Razorpay payload unchanged; mock payload simulated and secret-free.
- `/api/payments/razorpay/verify` → `verifyRazorpayCheckout`: server records + `paymentMode` match + attempt, HMAC, then server-side `GET /payments/{id}` must be `captured` with same gateway order/amount/INR; 202 pending, 503 unreachable, 409 conflicts, idempotent success; paid transition = attempt claim + `transitionOrder` in one transaction. Legacy `paymentMode` NULL → 409 (manual). State machine gained combined-state invariants.
- Recovery: `reconcile.ts` + `npm run payments:reconcile` (guarded). Dev runner `npm run payments:mock-checkout` (real API, key only in its own process). `MOCK_PAYMENT_CONFIRM_KEY` rejected in preview/production. Additive migration `payment_reconciliation`. `scripts/e2e-ui.mjs` made Node-24-safe (dynamic import).
- Tests: 5 new/rewritten integration files (`checkout-flows`, `razorpay-verify` 30, `reconcile` 7, plus updated mock/state-machine) with `tests/support/fake-razorpay.ts` (throws on any non-Razorpay host); unit: gateway adapter, config, ratchet rewritten to classify status vs non-status writers. Mutation checks: treating `authorized` as captured, or skipping the amount/order match, makes tests fail.
- **Evidence (2026-11-12, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 219/219 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 122/122 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓; `npm audit --omit=dev` 0. Dev runner exercised against a local `next start` (mock mode): order created as mock, confirmed, repeat idempotent; wrong key → 401.
- CI on `backend/m2-payments` @ `9119d56`: green (run 43155451686, Node 24, both jobs). Code commit `9119d56`.
- Direct status writers left: admin PATCH only (ratchet). Not centralized until M2-T6.
- Risks/deferred: M3 (order idempotency keys, stock reservation); M10 (webhooks, refunds; reconciliation is operator-run); in-flight orders at deploy → manual (runbook); Razorpay REST shapes verified against fakes only (confirm the `receipt` list filter in test mode); build still fetches Google Fonts.
### M2-T4 — mock payment confirmation + order payment mode (ADR 0008)
- `Order.paymentMode` (nullable; legacy NULL, never guessed; set server-side by `resolveOrderPaymentMode` in `createOrder`: COD → `request_only`, online → configured mode) with DB CHECKs (mode/method pairing, mock orders cannot hold Razorpay ids, `Payment` provider/mode pairing, mock payments only `mock_pay_*` ids). Migration `20261112031641_order_payment_mode` (additive).
- `POST /api/payments/mock/confirm`: 404 unless server mode is `mock` in development/test and `MOCK_PAYMENT_CONFIRM_KEY` is set; rate limit → `x-mock-confirm-key` (401) → strict body (422) → `confirmMockPayment`: order must be a mock order with a matching mock attempt, valid proof, amount/currency match; Payment claim + `transitionOrder` (new optional `tx` param) in one transaction; idempotent; cancelled/stale/mismatch → 409.
- Labels: order page and admin show `MOCK — no money moved` (only frontend files touched: `src/app/order/[number]/page.tsx`, `src/app/admin/page.tsx`); admin "to action" count excludes mock-paid.
- Tests: `unit/mock-payment.test.ts`, `integration/mock-confirm.test.ts` (28: confirm, idempotency, 8-way race, cancelled, cancel-vs-confirm race, bad proofs, cross-order proof, amount/currency mismatch, non-mock orders refused, 401/422/429/404 matrix incl. preview/production, no network, log hygiene, trigger-injected rollback of OrderEvent and Order writes), `integration/order-payment-mode.test.ts` (constraints, legacy NULL, createOrder modes, rendered labels). Fixtures only in `tests/support/mock-orders.ts`.
- **Evidence (2026-11-12, throwaway Postgres 16.13, fresh DB, `~/Developer/Velora-Valley`):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 214/214 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 72/72 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓.
- CI on `backend/m2-payments` @ `663fa7d`: green (run 43148644543). Code commit `663fa7d`.
- Incomplete until T5: public checkout does not create mock orders/attempts, nothing calls `mock/confirm`, `/verify` and `/api/orders` still write order status directly (ratchet unchanged: 3 files).
- Local note: a `cp -c`-cloned `node_modules` made `next build` fail with a Turbopack `next/font/google` error; a fresh `npm ci` fixed it (so that error is not always a Google network flake).
### M2-T3 — Payment model + providers (ADR 0007)
- `src/lib/payments/providers/{types,request-only,mock,razorpay,index}.ts`; `payments.ts` is now a facade (old exports unchanged, adds `currentPaymentProvider()`); `payments/records.ts` `recordPaymentAttempt`. request_only can never verify a payment (no automatic offline confirmation); mock is labelled, offline, and its factory refuses anything but mode=mock in development/test; razorpay is the old code moved (same request/HMAC). Additive migration `20261112025437_payment_attempts` (`Payment`, `PaymentProvider`, `PaymentMode`). No route or frontend change (routes move in T5).
- CI on `backend/m2-payments`: code commit `d72f0ca`; run 43145197561 (tip `Remove sync-conflict duplicate docs…`) failed once in `next build` with a `next/font/google` fetch error (runner network; tests and typecheck passed), green on re-run of the failed job. Note: the build fetches Google Fonts at build time, a recurring flake risk (consider self-hosting via `next/font/local` in a UI-approved task). `d72f0ca` accidentally included 7 sync-duplicate docs ("<name> 2.md"); removed in the next commit, net tree clean.
- Tests: `payment-providers.test.ts` and `payments-facade.test.ts` (provider behaviour, mock barriers, config selection, fail-closed, no secret in client payload), `integration/payment-records.test.ts` (attempt rows, unique `providerPaymentId`, enum rejection, cascade).
- **Evidence (2026-11-11, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 202/202 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 34/34 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓.
### M2-T2 — order state machine + event history (ADR 0006)
- `src/lib/orders/state-machine.ts`: order and payment transition tables, actor rules (`paid` only gateway/system; no admin or automatic offline confirmation), reason rules, `transitionOrder` = conditional `updateMany` + `OrderEvent` insert in one transaction; expected failures returned as codes (`stale_state`, `invalid_transition`, …). Migration `20261112022916_order_events` is additive (`OrderEvent`, `OrderActorType`). No route changes yet (T5/T6); `state-machine-ratchet.test.ts` pins the 3 legacy writer files by count so no new direct writer can appear.
- Tests: `state-machine.test.ts` (full 7×7 order and 4×4 payment matrices, actor/reason rules, mocked-tx behaviour), ratchet, `integration/state-machine.test.ts` (COD flow stays unpaid, gateway paid, stale/not_found, 8-way race → 1 winner/1 event, cancel-vs-dispatch race, cascade cleanup). Fixed the T1 drift test to apply later migrations.
- **Evidence (2026-11-11, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 175/175 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 30/30 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓. No frontend file changed.
- CI on `backend/m2-payments` @ `cfa73f6`: green (run 43142436402). Code commit `cfa73f6`.
### M2-T1 — order/payment status enums (`backend/m2-payments`, ADR 0005)
- `OrderStatus` / `PaymentStatus` / `PaymentMethod` Prisma enums (labels = legacy strings; `PaymentMethod` = `cod|razorpay` only; `cod` stays unpaid until externally confirmed; no auto-confirmation added). Hand-written migration `20261112021101_order_payment_enums`: `LOCK` → pre-check aborting on unknown values (no normalising) → `CREATE TYPE` → in-place `ALTER … USING` → default `'unpaid'` restored. Rollback + deploy order in `RUNBOOK-DATABASE.md`.
- Code touched: `prisma/schema.prisma`, admin `PATCH /orders/[id]` (zod derived from Prisma enums; 422 behaviour unchanged), integration test typing. Inventory: only `orders.ts`, `payment-verification.ts`, verify route, `orders` route, admin page/controls, order page read/write these fields; all compile unchanged. No frontend file changed.
- Tests added: `tests/unit/status-enums.test.ts` (28), `tests/integration/enum-migration.test.ts` (scratch DBs: 10 legacy rows preserved, empty table, 5 unknown-value aborts atomic, multi-offender message, no drift), `tests/integration/order-enums.test.ts`.
- **Evidence (2026-11-11, throwaway Postgres 16.13 @127.0.0.1:54329, fresh DB):** `verify:full` with `VERIFY_UI=1` → typecheck ✓ · unit 97/97 ✓ · env ✓ · migrate deploy ✓ · schema diff "No difference detected" ✓ · seed ✓ · integration 21/21 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓.
- CI on `backend/m2-payments` @ `47f939a`: green (run 43140441114, both jobs, incl. the migration rehearsal tests on Linux Postgres 16). Code commit: `47f939a`.
- Not done / unverified: rehearsal on a copy of production data (operator step, before release). Production not touched.
### M1 — foundation and safety (`backend/m1-foundation`)
- Build/DB separation, `0_init` baseline, guarded `db:*` scripts (ADR 0001).
- `/verify` hardening: no mutation on invalid signature, no paid-on-cancelled, idempotent, race-safe, 503 on bad config, rate limit (contracts updated).
- `PAYMENT_MODE` contract plus build gate `env:check` (ADR 0002).
- Fail-closed test/DB safety: `TEST_TARGET`, DB host allow-list, server handshake `/api/internal/test-environment` (ADR 0003).
- Vitest unit and integration suites, `verify` / `verify:full`, GitHub Actions CI (ADR 0004).
- Claude workflow: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*`, skills `next` / `verify` / `review`, `.claude/settings.json` deny rules.

**Evidence (2026-11-11, local):**
- `npm run verify:full` → typecheck ✓ · unit 69/69 ✓ · env check ✓ · migrate deploy ✓ · schema diff "No difference detected" ✓ · seed 30 products/40 variants ✓ · integration 6/6 ✓ · next build ✓ · API smoke 41/0 ✓ · UI (Chrome) 51/0 ✓
- Pre-M1 verify route run against the new tests: 8 failed / 7 passed (regressions detected).
- Guard refusals observed: unlisted remote DB host, missing `DATABASE_URL`, cleanup without `TEST_TARGET`, smoke vs `velora-valley.vercel.app`, smoke without `TEST_TARGET`, migrate under `NODE_ENV=production`, `env:check` with `mock` on `VERCEL_ENV=production`.
- Commit: see `git log backend/m1-foundation` (M1 commit message "M1: backend foundation…").
