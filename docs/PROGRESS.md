# Progress

_Read this first in a new session. Keep it under ~80 lines. Scope and AC per task: `BACKEND-ROADMAP.md`._

## Current
- **Milestone:** M2 in progress on `backend/m2-payments`. M2-T1..T3 done. T4+ need approval.
- **Branch:** M1 is integrated: `backend/development` = `3d3f00c` (M2-T2 integrated by fast-forward, no PR workflow). CI on it is green (run 43142853847). `main` = `55aa848`, untouched.
- **Last verified:** 2026-11-11, `npm run verify:full` on throwaway Postgres 16 (127.0.0.1): all gates green. See the M1 evidence below.

## Next up
| Task | Status | Notes |
|---|---|---|
| M2-T4 mock flow | proposed (needs approval) | next; adds `Order.paymentMode`, `POST /api/payments/mock/confirm`, MOCK label copy (copy needs user approval) |
| M2-T5..T6 | proposed | see `BACKEND-ROADMAP.md` M2 |

## Blockers / open items
1. **Preview DB isolation unverified.** Vercel project settings weren't accessible (local CLI account can't see the production team; Vercel MCP unauthorised). GitHub shows no Vercel deployments or statuses for this repo, so previews don't appear to be Git-triggered. M1 builds are DB-write-free regardless; reads during a preview build would still use whatever `DATABASE_URL` preview has. Owner: user (Vercel dashboard).
2. **Production not baselined** onto Prisma Migrate (`docs/RUNBOOK-DATABASE.md`). Operator task, planned in M9-T1 or before the first production migration.
3. (resolved) CI green on `backend/development` @ `38b476e`.
4. Dev-dependency advisories: `postcss` (high), `esbuild` via `tsx` (moderate). Prod deps clean. Tracked as M9-T9.
5. Untracked "<name> 2.<ext>" duplicate files keep appearing in the working tree (looks like iCloud/Desktop sync conflicts; not committed, not created by tooling). Consider moving the repo out of a synced Desktop folder.
6. Local Node is 20.19.6; project targets 24 (`.nvmrc`, CI uses 24).

## Done
### M2-T3 — Payment model + providers (ADR 0007)
- `src/lib/payments/providers/{types,request-only,mock,razorpay,index}.ts`; `payments.ts` is now a facade (old exports unchanged, adds `currentPaymentProvider()`); `payments/records.ts` `recordPaymentAttempt`. request_only can never verify a payment (no automatic offline confirmation); mock is labelled, offline, and its factory refuses anything but mode=mock in development/test; razorpay is the old code moved (same request/HMAC). Additive migration `20261112025437_payment_attempts` (`Payment`, `PaymentProvider`, `PaymentMode`). No route or frontend change (routes move in T5).
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
