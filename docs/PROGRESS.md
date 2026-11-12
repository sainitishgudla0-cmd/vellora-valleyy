# Progress

_Read this first in a new session. Keep it under ~80 lines. Scope and AC per task: `BACKEND-ROADMAP.md`._

## Current
- **Milestone:** M1-M3 integrated. **M4 (admin identity, roles, audit; T1-T5) complete and integrated**; T6 (admin UI) needs approval. M5 needs approval.
- **Branch:** M1 is integrated: `backend/development` fast-forwarded from `backend/m2-payments` after each task (no PR workflow); see the M2-T6 entry for the latest SHA and CI run. `main` = `55aa848`, untouched. Working copy moved to `~/Developer/Velora-Valley` (the Desktop copy is iCloud-synced and spawns duplicate files). `main` = `55aa848`, untouched.
- **Last verified:** 2026-11-11, `npm run verify:full` on throwaway Postgres 16 (127.0.0.1): all gates green. See the M1 evidence below.

## Next up
| Task | Status | Notes |
|---|---|---|
| M3 inventory + order idempotency | done on `backend/m3-inventory` (see entry) | ADR 0011 |
| M4 admin accounts, roles, audit | done (T1-T5; T6 UI not built) | ADR 0012 |
| M5 | proposed (needs approval) | see `BACKEND-ROADMAP.md` |

## Blockers / open items
1. **Preview DB isolation unverified.** Vercel project settings weren't accessible (local CLI account can't see the production team; Vercel MCP unauthorised). GitHub shows no Vercel deployments or statuses for this repo, so previews don't appear to be Git-triggered. M1 builds are DB-write-free regardless; reads during a preview build would still use whatever `DATABASE_URL` preview has. Owner: user (Vercel dashboard).
2. **Production not baselined** onto Prisma Migrate (`docs/RUNBOOK-DATABASE.md`). Operator task, planned in M9-T1 or before the first production migration.
3. (resolved) CI green on `backend/development` @ `38b476e`.
4. Dev-dependency advisories: `postcss` (high), `esbuild` via `tsx` (moderate). Prod deps clean. Tracked as M9-T9.
5. (resolved 2026-11-12) iCloud sync duplicates ("<name> 2.ext") in `~/Desktop/Velora Valley`; repo relocated to `~/Developer/Velora-Valley`. Stage files by explicit path only (never `git add .` / `git add docs`).
6. Local Node is 20.19.6; project targets 24 (`.nvmrc`, CI uses 24).

## Done
### M4 — admin identity, sessions, roles and audit (`backend/m4-admin-auth`, ADR 0012)
- T1 `AdminUser` / `AdminSession` / `AuditLog` (migration `20261114090000_admin_auth`, additive). T2 `src/lib/auth/admin.ts`: DB sessions (random token, only its HMAC stored; 8 h absolute, 2 h idle, revocable), `requireAdmin(req, permission)` (401/403), roles `owner|operations|catalog|viewer` via a permission matrix, scrypt passwords, 5-failure/15-minute lockout with one identical 401 for every failure, session replaced on login, logout/deactivation/role/password change revoke at once. T3 same-origin check on every mutation (login/logout included). T4 `npm run admin:bootstrap` (guarded; first owner + owner recovery `--reset`); shared `ADMIN_PASSWORD` kept as a transition login (legacy sessions: owner-level for the dashboard, never `users:manage`; off with `ADMIN_LEGACY_LOGIN=off`). T5 every admin route calls `requireAdmin` and every mutation `writeAudit` (ratchet test); order events/ledger now record the account id. API for accounts, sessions, own password and the audit log. Last active owner is protected (row lock).
- **Not built:** T6 admin UI (needs approval; the dashboard login form cannot send an email, so the shared password cannot be retired until it does). 2FA deferred.
- Tests: `integration/{admin-auth,admin-users}` (role x route matrix, lockout, revocation, CSRF, audit completeness without secrets, last-owner race, bootstrap script run as a child process), `unit/{auth-core,admin-routes-ratchet}`; existing admin tests moved from auth mocks to real sessions. Mutation checks: removing the permission check, the lockout or the logout revocation each fails the suites.
- **Evidence (2026-11-14, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` -> typecheck ok, unit 289/289, env ok, migrate deploy ok, schema diff none, integration 273/273, build ok, smoke 41/0, UI 51/0; `npm audit --omit=dev` 0. No frontend file changed.
- CI on `backend/m4-admin-auth` @ `46b1749`: green (run 43177905336, Node 24, both jobs). Code commit `46b1749`.
- Open: admin UI (T6) and retiring `ADMIN_PASSWORD`; 2FA; run the bootstrap before relying on individual accounts in production; audit log has no retention policy yet.
### M3 — inventory, expiry and order idempotency (`backend/m3-inventory`, ADR 0011)
- T1 `Variant.trackInventory` (opt-in, default off = legacy manual flag) + `stockQuantity`/`reserved`, append-only `InventoryMovement` ledger, DB CHECKs (no negative stock / over-reservation), derived `inStock` kept in API output (catalog + cart validate). Counters written only by `src/lib/inventory` (ratchet test). T2 `createOrder` is one transaction: guarded `UPDATE ... WHERE stock - reserved >= qty`, order, lines, attempt, idempotency claim; 409 names the item and units left. T3 cancel/dispatch inside the state machine release/consume holds (read from the ledger); `expireUnpaidOrders` + bearer-guarded `GET /api/internal/orders/expire` (gateway asked first; COD not expired; no cron entry in `vercel.json`, see runbook). T4 `Idempotency-Key` (hash stored, 24 h replay incl. 502 outcomes, 422 on body mismatch). T5 order-number collision retry (3). T6 `PATCH /api/admin/variants/[id]` `trackInventory`/`stockAdjust` + `GET /api/admin/variants/low-stock`.
- Migration `20261113090000_inventory_and_idempotency` (additive; CHECKs hand-added). No frontend file changed: the unchanged dashboard still works (price edits on tracked variants; `inStock` ignored for them).
- Tests: `integration/{inventory,order-idempotency,order-expiry,admin-inventory}` (80 new), `unit/{inventory,idempotency,inventory-ratchet}`; parallel last-unit test x20 inside the suite and the suites run 5 more times green; every file asserts ledger drift is empty. Mutation checks: removing the state-machine hook or the availability guard fails the suites.
- **Evidence (2026-11-13, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` -> typecheck ok, unit 248/248, env ok, migrate deploy ok, schema diff none, integration 211/211, build ok, smoke 41/0, UI 51/0; `npm audit --omit=dev` 0.
- CI on `backend/m3-inventory` @ `aead591`: green (run 43169872270, Node 24, both jobs). Code commit `aead591`.
- First CI on `backend/development` @ `fc5aeaa` (run 43170152664) FAILED: `enum-migration` drift test hit the 5 s default timeout (it replays every migration in a scratch DB; passed on the branch run). Fixed forward with a 60 s file timeout (`5d97674`); CI green on `backend/m3-inventory` (run 43170430445) and on `backend/development` @ `5d97674` (run 43170681671).
- Open: storefront does not send `Idempotency-Key` and the dashboard has no stock UI (frontend approval needed); unpaid COD orders hold stock until staff act; late payment after expiry needs a refund (M10); backorders / wholesale allocations not modelled; add the cron once the Vercel plan is confirmed.
### M2-T6 — admin order/payment changes through the state machine (ADR 0010)
- `PATCH /api/admin/orders/[id]` → `updateOrderAsAdmin` → `transitionOrder` (actor admin): invalid transitions 409, reason/reference 422, admin can never set an order `paid`. Manual payment confirmation only for request-only orders (payment-only, reason + external reference stored on `Payment.manualReference` (unique) and the event); `paid → refunded` bookkeeping with reason; gateway/mock/legacy payments not editable. Payment row + order + event in one transaction. State machine: admin may confirm a payment only with a valid reference, payment-only. Additive migration `manual_payment_confirmation`. Direct-writer ratchet legacy list is now empty. No frontend change (dropdown unchanged; no UI yet for entering a reference — needs approval).
- Tests: `integration/admin-orders.test.ts` (25: transitions, invalid 409, no-paid-by-admin, default/explicit reasons, manual confirm incl. reference reuse rollback, refused for razorpay/mock/legacy/no-record/cancelled, refund bookkeeping, race, trigger-injected rollback, DB CHECK), state-machine unit additions, PATCH boundary unit tests rewritten.
- **Evidence (2026-11-12, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** `verify:full` + `VERIFY_UI=1` → typecheck ✓ · unit 231/231 ✓ · env ✓ · migrate deploy ✓ · schema diff none ✓ · integration 147/147 ✓ · build ✓ · smoke 41/0 ✓ · UI 51/0 ✓; `npm audit --omit=dev` 0.
- CI on `backend/m2-payments` @ `46f7eb7`: green (run 43157297749, Node 24). Code commit `46f7eb7`.
- M2 acceptance (roadmap): no application code writes `Order.status`/`paymentStatus` outside the state machine (ratchet test, empty legacy list); mock impossible in preview/production (tests, ADR 0002/0008); 41 smoke + 51 UI pass; contracts updated.
- Open for later: admin UI for payment references; per-person admin identity (M4); order idempotency + stock (M3); webhooks/refunds (M10).
### M2-T5 — order/payment integration (ADR 0009)
- `createOrder` inserts order + `Payment` attempt atomically; `/api/orders` uses `startOnlinePayment` (gateway outside any transaction: definite failure cancels via the state machine, unknown outcome keeps `awaiting_payment`, flags reconciliation, 502); `/verify` checks server records + HMAC + a server-side captured payment; `reconcile.ts` / `npm run payments:reconcile` recovers unknown outcomes; mock confirm key rejected in preview/production. Tests: `checkout-flows`, `razorpay-verify` (30), `reconcile` with `fake-razorpay` (throws on any other host). Evidence at the time: unit 219, integration 122, smoke 41, UI 51 (CI run 43155451686). Deferred: webhooks/refunds (M10); Razorpay `receipt` list filter to be confirmed in test mode; build fetches Google Fonts.
### M2-T4 — mock payment confirmation + order payment mode (ADR 0008)
- `Order.paymentMode` (NULL = legacy, never guessed) with DB CHECKs; `POST /api/payments/mock/confirm` is development/test only (mode mock + `MOCK_PAYMENT_CONFIRM_KEY`, 404 otherwise; rate limit, key, strict body, then service); labels `MOCK — no money moved`. Tests: `mock-payment`, `mock-confirm` (28), `order-payment-mode`. Evidence at the time: unit 214, integration 72, smoke 41, UI 51 (CI run 43148644543). Local note: a `cp -c`-cloned `node_modules` made `next build` fail with a Turbopack `next/font/google` error; a fresh `npm ci` fixed it.
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
