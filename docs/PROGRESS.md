# Progress

_Read this first in a new session. Keep it under ~80 lines. Scope and AC per task: `BACKEND-ROADMAP.md`._

## Current
- **Milestone:** M2 in progress on `backend/m2-payments`. M2-T1 done; M2-T2 not started and needs approval.
- **Branch:** M1 is integrated: `backend/development` = `38b476e` (docs commit on top of M1 `aaeb082`; fast-forward, no PR workflow). CI on `38b476e` is green (run 43138798622). `main` = `55aa848`, untouched.
- **Last verified:** 2026-11-11, `npm run verify:full` on throwaway Postgres 16 (127.0.0.1): all gates green. See the M1 evidence below.

## Next up
| Task | Status | Notes |
|---|---|---|
| M2-T2 state machine | proposed (needs approval) | next; also records the staff payment-reference / audited manual confirmation design with T6 |
| M2-T3..T6 | proposed | see `BACKEND-ROADMAP.md` M2 |

## Blockers / open items
1. **Preview DB isolation unverified.** Vercel project settings weren't accessible (local CLI account can't see the production team; Vercel MCP unauthorised). GitHub shows no Vercel deployments or statuses for this repo, so previews don't appear to be Git-triggered. M1 builds are DB-write-free regardless; reads during a preview build would still use whatever `DATABASE_URL` preview has. Owner: user (Vercel dashboard).
2. **Production not baselined** onto Prisma Migrate (`docs/RUNBOOK-DATABASE.md`). Operator task, planned in M9-T1 or before the first production migration.
3. (resolved) CI green on `backend/development` @ `38b476e`.
4. Dev-dependency advisories: `postcss` (high), `esbuild` via `tsx` (moderate). Prod deps clean. Tracked as M9-T9.
5. Local Node is 20.19.6; project targets 24 (`.nvmrc`, CI uses 24).

## Done
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
