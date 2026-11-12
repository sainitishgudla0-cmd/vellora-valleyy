# Progress

_Read this first in a new session. Keep it under ~80 lines. Scope and AC per task: `BACKEND-ROADMAP.md`._

## Current
- **Milestone:** M2 complete and integrated. **M3 (inventory, expiry, idempotency; T1..T6) implemented on `backend/m3-inventory`**, awaiting CI then fast-forward; M4 needs approval.
- **Branch:** M1 is integrated: `backend/development` fast-forwarded from `backend/m2-payments` after each task (no PR workflow); see the M2-T6 entry for the latest SHA and CI run. `main` = `55aa848`, untouched. Working copy moved to `~/Developer/Velora-Valley` (the Desktop copy is iCloud-synced and spawns duplicate files). `main` = `55aa848`, untouched.
- **Last verified:** 2026-11-11, `npm run verify:full` on throwaway Postgres 16 (127.0.0.1): all gates green. See the M1 evidence below.

## Next up
| Task | Status | Notes |
|---|---|---|
| M3 inventory + order idempotency | done on `backend/m3-inventory` (see entry) | ADR 0011 |
| M4 | proposed (needs approval) | see `BACKEND-ROADMAP.md` |

## Blockers / open items
1. **Preview DB isolation unverified.** Vercel project settings weren't accessible (local CLI account can't see the production team; Vercel MCP unauthorised). GitHub shows no Vercel deployments or statuses for this repo, so previews don't appear to be Git-triggered. M1 builds are DB-write-free regardless; reads during a preview build would still use whatever `DATABASE_URL` preview has. Owner: user (Vercel dashboard).
2. **Production not baselined** onto Prisma Migrate (`docs/RUNBOOK-DATABASE.md`). Operator task, planned in M9-T1 or before the first production migration.
3. (resolved) CI green on `backend/development` @ `38b476e`.
4. Dev-dependency advisories: `postcss` (high), `esbuild` via `tsx` (moderate). Prod deps clean. Tracked as M9-T9.
5. (resolved 2026-11-12) iCloud sync duplicates ("<name> 2.ext") in `~/Desktop/Velora Valley`; repo relocated to `~/Developer/Velora-Valley`. Stage files by explicit path only (never `git add .` / `git add docs`).
6. Local Node is 20.19.6; project targets 24 (`.nvmrc`, CI uses 24).

## Done
### M3 — inventory, expiry and order idempotency (`backend/m3-inventory`, ADR 0011)
- T1 `Variant.trackInventory` (opt-in, default off = legacy manual flag) + `stockQuantity`/`reserved`, append-only `InventoryMovement` ledger, DB CHECKs (no negative stock / over-reservation), derived `inStock` kept in API output (catalog + cart validate). Counters written only by `src/lib/inventory` (ratchet test). T2 `createOrder` is one transaction: guarded `UPDATE ... WHERE stock - reserved >= qty`, order, lines, attempt, idempotency claim; 409 names the item and units left. T3 cancel/dispatch inside the state machine release/consume holds (read from the ledger); `expireUnpaidOrders` + bearer-guarded `GET /api/internal/orders/expire` (gateway asked first; COD not expired; no cron entry in `vercel.json`, see runbook). T4 `Idempotency-Key` (hash stored, 24 h replay incl. 502 outcomes, 422 on body mismatch). T5 order-number collision retry (3). T6 `PATCH /api/admin/variants/[id]` `trackInventory`/`stockAdjust` + `GET /api/admin/variants/low-stock`.
- Migration `20261113090000_inventory_and_idempotency` (additive; CHECKs hand-added). No frontend file changed: the unchanged dashboard still works (price edits on tracked variants; `inStock` ignored for them).
- Tests: `integration/{inventory,order-idempotency,order-expiry,admin-inventory}` (80 new), `unit/{inventory,idempotency,inventory-ratchet}`; parallel last-unit test x20 inside the suite and the suites run 5 more times green; every file asserts ledger drift is empty. Mutation checks: removing the state-machine hook or the availability guard fails the suites.
- **Evidence (2026-11-13, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` -> typecheck ok, unit 248/248, env ok, migrate deploy ok, schema diff none, integration 211/211, build ok, smoke 41/0, UI 51/0; `npm audit --omit=dev` 0.
- Open: storefront does not send `Idempotency-Key` and the dashboard has no stock UI (frontend approval needed); unpaid COD orders hold stock until staff act; late payment after expiry needs a refund (M10); backorders / wholesale allocations not modelled; add the cron once the Vercel plan is confirmed.
### M2-T6 — admin order/payment changes through the state machine (ADR 0010)
- `PATCH /api/admin/orders/[id]` → `updateOrderAsAdmin` → `transitionOrder` (actor admin): invalid transitions 409, reason/reference 422, admin can never set an order `paid`. Manual payment confirmation only for request-only orders (payment-only, reason + external reference stored on `Payment.manualReference` (unique) and the event); `paid → refunded` bookkeeping with reason; gateway/mock/legacy payments not editable. Payment row + order + event in one transaction. State machine: admin may confirm a payment only with a valid reference, payment-only. Additive migration `manual_payment_confirmation`. Direct-writer ratchet legacy list is now empty. No frontend change (dropdown unchanged; no UI yet for entering a reference — needs approval).
- Tests: `integration/admin-orders.test.ts` (25: transitions, invalid 409, no-paid-by-admin, default/explicit reasons, manual confirm incl. reference reuse rollback, refused for razorpay/mock/legacy/no-record/cancelled, refund bookkeeping, race, trigger-injected rollback, DB CHECK), state-machine unit additions, PATCH boundary unit tests rewritten.
- **Evidence (2026-11-12, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 231/231 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 147/147 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓; `npm audit --omit=dev` 0.
- CI on `backend/m2-payments` @ `46f7eb7`: green (run 43157297749, Node 24). Code commit `46f7eb7`.
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
- Providers `request_only` / `mock` / `razorpay` behind `src/lib/payments/providers`, `payments.ts` facade, `Payment` model (migration `payment_attempts`). request_only can never verify a payment; mock refuses anything but mode=mock in dev/test. Tests: `payment-providers`, `payments-facade`, `integration/payment-records`. Evidence at the time: unit 202, integration 34, smoke 41, UI 51 (CI `d72f0ca`; a one-off `next/font/google` fetch flake passed on re-run; 7 sync-duplicate docs were added and removed in the following commit).
### M2-T2 — order state machine + event history (ADR 0006)
- `src/lib/orders/state-machine.ts`: transition tables, actor/reason rules, `transitionOrder` = conditional `updateMany` + `OrderEvent` in one transaction (migration `order_events`). Tests: full matrices, ratchet, integration races. Evidence at the time: unit 175, integration 30, smoke 41, UI 51 (CI run 43142436402).
### M2-T1 — order/payment status enums (`backend/m2-payments`, ADR 0005)
- `OrderStatus` / `PaymentStatus` / `PaymentMethod` enums with the legacy strings; hand-written, pre-checked, in-place migration `order_payment_enums` (rollback in `RUNBOOK-DATABASE.md`). No auto-confirmation of offline payments.
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
