# M11 — Stabilisation, integration and release readiness

Central tracker for M11 (execution, evidence, blockers). `PROGRESS.md` points here. Operator checklists stay in `RELEASE.md`; database procedure in `RUNBOOK-DATABASE.md`. One bounded task per `/next`; each task = fix + regression test + review + evidence + checkpoint.

- **Branch:** `backend/m11-stabilization` from `backend/development` @ `5225e44` (2026-11-14; origin matched, tree clean). `main` = `55aa848`, untouched.
- **Status legend:** confirmed · partially mitigated · unverified (needs operator/external evidence) · false positive · **fixed** (with evidence).

## 1. Findings (audited against `5225e44`)
| ID | Sev | Status | Finding (evidence) | Task |
|---|---|---|---|---|
| F01 | Critical | fix prepared (P2-T1) | `main` `package.json` `vercel-build` = `prisma db push --skip-generate && tsx prisma/seed.ts && next build`: every production deploy of `main` mutates the DB. `backend/development` = `env:check && prisma generate && next build`. | P2-T1 |
| F02 | High | partially fixed | Procedure corrected 2026-11-15: production is compared with the `0_init` schema (`aaeb082`, byte-identical to `main`'s `schema.prisma`) instead of `--to-migrations` (which printed 132 DDL statements on a correct `main`-shaped DB); runbook steps 4-5 also wrongly expected a no-op deploy. Rehearsed on a disposable DB (empty diff; P3005 before baseline; resolve `0_init`; 13 applied; no drift). Pending: read-only check of real production and a rehearsal on a Neon clone with real data (operator). | P2-T2 |
| F03 | High | **fixed (P1-T1)** | `src/lib/orders/admin-update.ts` let `orders:write` (operations, legacy shared password) move a captured Razorpay payment `paid → refunded` with no gateway refund; it then blocked the real refund (`not_refundable`). Also via `{status: cancelled, paymentStatus: refunded}`. ADR 0019. | P1-T1 |
| F04 | High | **fixed (P1-T2)**, policy provisional | Manual `unpaid → paid` is request-only, reason + unique `manualReference` (DB unique, CHECK request-only), atomic with `OrderEvent`. Gaps: held by `operations` and the legacy session (`roles.ts`, `ACCOUNT_ONLY` excludes it), no amount/method attestation, same route as status changes. Same gaps for request-only refund bookkeeping. | P1-T2 |
| F05 | High | **fixed (P1-T5)** | `legacyLoginEnabled()` = `ADMIN_PASSWORD` set and `ADMIN_LEGACY_LOGIN≠off` (`src/lib/auth/admin.ts:40`); legacy session = owner minus `users:manage`/`refunds:write`, so it keeps `orders:write`, `catalog:write`, `tax:write`, `testdata:write`. | P1-T5 |
| F06 | High | confirmed (code) | After `payment.failed` (`razorpay-verify.ts` `markFailed`, also webhook) the order is `awaiting_payment`/`failed`, attempt `failed`. `expireUnpaidOrders` selects only attempts `unpaid` on orders `paymentStatus: unpaid` (`expire.ts:40-45`) → stock held indefinitely. Needs the failing test first. | P1-T3 |
| F07 | Medium-High | **fixed (P1-T4)** | `writeAudit` (`src/lib/auth/audit.ts:22-40`) swallows DB errors; mutations succeed unaudited. | P1-T4 |
| F08 | Medium | **fixed (P1-T6)** | `rate-limit-store.ts:72-77` falls back to a per-instance Map for every caller when Postgres fails (login, OTP, refunds included). | P1-T6 |
| F09 | High (launch) | code done (P3-T1); provider = business | No OTP sender: `CUSTOMER_OTP_MODE` mock only, refused in preview/production; customer sign-in is off in production. | P3-T1 (provider = business) |
| F10 | High (launch) | code done (P3-T1); provider = business | Notifications: `currentEmailProvider()` returns the mock or null (`notify/provider.ts:50-52`); nothing is sent in production. | P3-T1 |
| F11 | High (ops) | tooling done (P3-T3); counts = business | `Variant.trackInventory @default(false)`; catalogue uses the manual `inStock` flag, so no oversell protection until stock is initialised. | P3-T3 |
| F12 | Medium | surfaced (P3-T4 readiness); rules = business | No active `ShippingRule` = every pincode serviceable at the legacy fee (ADR 0015). | P3-T4 |
| F13 | High | **fixed (P3-T5)**; plan check = operator | `vercel.json` has no `crons`; expiry, reconciliation and outbox dispatch never run in Vercel. | P3-T5 |
| F14 | High (legal) | sign-off tooling (P3-T6); rates = accountant | No `TaxRate` rows or `SELLER_GSTIN`; rounding, IRN applicability, credit notes unbuilt/unapproved. | P3-T6 (accountant) |
| F15 | Medium | **fixed (P5-T3)** pending first CI run | Linux CI skips the 22 visual comparisons (baselines are macOS-local, gitignored). | P5-T3 |
| F16 | High | unverified | Preview/production DB isolation: code gate exists (`env:check`, ADR 0017); Vercel scopes not inspected. | P6-T1 (operator) |
| F17 | Medium | unverified | Branch protection on `main`/`backend/development` not inspected (GitHub connector failed this session). | P6-T1 (operator) |
| F18 | Medium | confirmed | `/account` is linked from no page (only `src/app/account/orders/[number]/page.tsx` links back). Account/wholesale journeys only proven by Playwright on direct URLs. | P4-T1 (design approval) |
| F19 | High | unverified | Monitoring vendor, uptime check, production restore drill, RPO/RTO sign-off: none evidenced. | P7-T2 (operator) |
| F20 | High | unverified | Refund/webhook/reconcile behaviour proven only against `tests/support/fake-razorpay.ts`. | P6-T2 |
| N01 | Low | **fixed (P4-T4)** | `ARCHITECTURE.md` still says "State as of M1" and describes the shared-password admin; docs drift only. | P4-T4 |
| F21 | High | **fixed** | `next` 16.4.2 (backend and `main`) is covered by 7 GitHub advisories (moderate: `use cache` leaks/poisoning, image SVG bypass, Edge cookie exposure, response injection); `npm audit` reported it but CI audits only `--audit-level=high`. Next 16.4.5 on both lines. | deps |
| F22 | High | confirmed, documented | No compatible overlap between `main`'s code and the migrated schema (checkout fails; a single-row create commits then throws) or between the backend and `main`'s schema (build fails on `Variant.trackInventory`). First cutover = planned ordering outage; rollback to `main` needs the pre-cutover DB. `RUNBOOK-DATABASE.md` matrix, `RELEASE.md` B0. | P2-T3 |

## 2. Phases and tasks
Each task: implementation, regression test (failing first where practical), disposable-Postgres integration for transactional paths, `npm run verify`, review, commit, CI, fast-forward. Milestone gates (`verify:full` + `VERIFY_UI=1`) at the end of P1, P3, P5.

**P0 — Baseline and risk validation** (done 2026-11-14): repo/remote/SHA verified, branch created, findings table above. AC: every lead labelled with file evidence. 

**P1 — Financial integrity and critical security** (depends P0)
| Task | Deliverable | Tests / AC | Status |
|---|---|---|---|
| P1-T1 | No hand-marked gateway refunds (F03) | gateway `paid→refunded` PATCH = 409 for owner/operations/legacy, test+live, combined change; real refund still works; request-only bookkeeping unchanged | **done** (evidence §4) |
| P1-T2 | Dedicated offline-collection operation (F04): own permission (owner or new `payments:record`, never legacy), amount = order total, method, unique reference, reason, immutable record, transactional; request-only refund bookkeeping moved under it | role matrix, amount mismatch, duplicate reference under concurrency, rollback injection | **done (infrastructure; policy provisional)**: owner-only `payments:record`, full-amount + method attestation, immutable record (trigger), gateway offline refunds still refused (ADR 0024). Who else may record = business |
| P1-T3 | Failed online attempts expire and release stock (F06), without touching captured/authorised payments or a legitimate retry | failing test first: `failed` attempt past window → cancelled + stock released; gateway shows captured → paid, not cancelled; retry in window untouched; concurrent expiry+webhook | pending |
| P1-T4 | Audit classes (F07): critical mutations (refund, payment record, role/user change) write audit in the same transaction or fail closed; others keep best-effort + log | injected audit-insert failure rolls the critical change back | **done** (§5, ADR 0021) |
| P1-T5 | Legacy login retirement path (F05): document bootstrap → `ADMIN_LEGACY_LOGIN=off`; `env:check` refuses production with legacy on once an owner exists (or launch gate); owner recovery = `admin:bootstrap --reset` | env gate unit tests; legacy denied financial permissions | **done** (§5, ADR 0022) |
| P1-T6 | Rate limiter fail-closed for auth/OTP/payment/refund/privileged routes (F08), fail-open per-instance only for public reads | DB-down test per class | **done** (§5, ADR 0022) |

**P2 — Migrations and deployment safety** (depends P0; independent of P1)
| P2-T1 | Safe transition off `main`'s DB-mutating build (F01): a minimal `main`-compatible change set (build script only) prepared on a branch for the user to promote; no merge of the backend | build never connects for writes (static check + build run against a read-only role) | **prepared**: branch `backend/m11-main-build-fix` (`ab07872`, + next bump) for the owner to promote; ratchet test |
| P2-T2 | Corrected baselining procedure (F02): diff production vs `0_init` (`--to-schema-datamodel` at the `0_init` schema), drift handling, rehearsal on a Neon clone (resolve `0_init` → deploy 13 → app read/write smoke) | rehearsal script against a disposable DB seeded with `main`'s `db push` schema | **done** (rehearsal script, 21/21); Neon-clone run = operator (P6-T4) |
| P2-T3 | Release compatibility matrix: app version vs migration level, rollback order | doc + migration-order test | **done** (measured matrix, F22; migration-safety test; RELEASE B0) |

**P3 — Business services and configuration** (depends P1)
P3-T1 email/OTP provider adapter behind outbox (F09/F10; provider choice = business, DLT for SMS) · P3-T2 notification failure handling/dead-letter admin view (API) · P3-T3 stock initialisation tooling + launch check that tracked variants are initialised (F11) · P3-T4 shipping rules required in production (or explicit opt-out) (F12) · P3-T5 `vercel.json` crons + auth for expiry, reconcile, outbox (F13; plan limits confirmed by operator) · P3-T6 tax data import + invoice behaviour sign-off pack for the accountant; credit notes scoped (F14). Each blocked item records its blocker.
Status (2026-11-20): **P3-T1 done** (SMTP adapter, ADR 0023; provider choice = business) · **P3-T2 done** (dead letters were already listed/retryable; now on the admin Operations tab + readiness) · **P3-T3 done** (`inventory:import`, compare-and-set; counts = business) · **P3-T4 done as a readiness check** (no rules = flat fee is reported, rules entered in Admin → Settings; refusing orders without rules would stop today's sales, so it is not forced) · **P3-T5 done** (`vercel.json` crons, `CRON_SECRET` required in production; plan check = operator) · **P3-T6 tooling done** (`tax:signoff-sheet`, Settings → GST rates; approval = accountant).

**P4 — Frontend/backend integration and staff usability** (depends P3; UI changes need explicit approval)
P4-T1 link `/account` from the storefront (F18, design approval) · P4-T2 admin UI for refunds and offline collections (uses P1-T2/P1-T1 APIs) · P4-T3 admin stock/shipping/tax screens or documented API runbook · P4-T4 docs refresh (N01).
Status (2026-11-20): **P4-T2/T3 done** for staff: admin order page (history, payments, refunds for owners, pay-on-delivery collection, shipments and tracking status, invoice with missing-HSN detail), Products stock tracking/adjust, Operations tab (readiness, payment exceptions, dead letters with retry, low stock), Settings tab (shipping rules, GST rates); Playwright `admin-operations.spec.ts`. **P4-T4 done** (`ARCHITECTURE.md`). **P4-T1 blocked**: linking `/account` from the storefront changes every page's approved design and is pointless while sign-in is off in production; needs the owner's design approval and P3-T1 configured. The refund form is exercised only through the API tests (no gateway in the browser test environment).

**P5 — Security, reliability, regression and performance** (depends P4)
P5-T1 acceptance scenarios (§3) as Playwright + integration · P5-T2 failure-recovery suite (duplicate submit, gateway outage, DB rollback, email failure) · P5-T3 Linux visual baselines in CI (F15) · P5-T4 security review (`/security-review`), load test of checkout and stock contention.
Status (2026-11-20): **P5-T3 done**: `npm run test:visual-ref` builds the approved commit (`tests/e2e/visual-baseline.ref`), captures the 22 storefront screenshots and compares the current build on the same machine; CI job `visual` runs it on Linux (no baselines in git).

**P6 — Staging with real providers** (depends P5; operator authorisation for each external step)
P6-T1 Vercel preview isolation + branch protection evidence (F16/F17) · P6-T2 Razorpay test-mode run: pay, fail, retry, webhook, duplicate webhook, full/partial refund, dashboard refund adoption, reconcile (F20; `RELEASE.md` E1) · P6-T3 real email/OTP delivery in staging · P6-T4 migration rehearsal on a production clone (P2-T2).

**P7 — Production launch and handover** (depends P6; user authorises every step)
P7-T1 baselining + migrations (operator) · P7-T2 monitoring/alerting, restore drill, RPO/RTO (F19) · P7-T3 promote `main`, deploy, smoke, rollback rehearsal · P7-T4 staff handover: daily operating scenarios run by staff.

## 3. Acceptance scenarios (P5)
Retail (browse → cart → stock check → delivery quote → order → pay → confirm → dispatch → deliver → invoice + notifications) · Guest (order → token view → track → claim after sign-in) · Customer (OTP → addresses → orders → invoices → export/erasure) · Wholesale (apply → approve → price list → MOQ → quote → price → accept → order → credit check → GST invoice) · Admin (sign in → products/stock → confirm → offline collection → ship → audit → invoice → authorised refund → reconciliation exception) · Failure (duplicate submit, failed payment, browser drop, gateway outage, cancel, shortage, expired quote, email failure, duplicate webhook, DB rollback).

## 4. Production acceptance gates
All must have evidence; CI green alone is never enough. ☐ all High findings fixed or safely blocked · ☐ no unauthorised financial-state change (P1) · ☐ ledger/order/event consistent under concurrency · ☐ no oversell with tracking initialised · ☐ failed/expired orders release stock · ☐ retail/wholesale/guest/registered journeys through the UI · ☐ real email/OTP · ☐ staff-confirmed shipping rules · ☐ accountant-approved tax/invoices · ☐ protected, running scheduled jobs · ☐ no DB writes during build · ☐ migrations rehearsed on a production clone · ☐ restore + app rollback rehearsed · ☐ CI incl. substantive browser/visual checks · ☐ Razorpay test-mode pay/webhook/refund journeys · ☐ preview/production isolation verified by operator · ☐ monitoring and alerting · ☐ staff run daily scenarios unaided.

## 5. Task log
### P1-T1 — no hand-marked gateway refunds (F03), 2026-11-14
- **Failure:** an operations user or the shared admin password could set a captured Razorpay payment to `refunded` with a reason; no money moved, the customer was told nothing reliable, and the owner could then no longer refund it (`not_refundable`).
- **Root cause:** `updateOrderAsAdmin` applied the request-only restriction to `unpaid → paid` only; `paid → refunded` checked only "not mock, not legacy".
- **Fix:** `src/lib/orders/admin-update.ts`: both edits require order `paymentMode = request_only` **and** attempt `provider = request_only`; otherwise `409 payment_edit_not_allowed` (existing code and status). Gateway payments reach `refunded` only via `refunds.ts` (`settleFullRefund`, actor `gateway`). No schema or UI change. ADR 0019; contracts updated.
- **Tests:** `tests/integration/admin-orders.test.ts` (request-only bookkeeping still 200; owner/operations/legacy × `razorpay_test`/`razorpay_live` → 409, order/payment unchanged, no `OrderEvent`, no `Refund`, audit `rejected` with the code; combined cancel+refund; request-only order with a gateway attempt), `tests/integration/refunds.test.ts` (PATCH refused, then the owner refund succeeds and the only `→ refunded` event has actor `gateway`). Pre-fix: 3 failed / 44 passed. Mutation: removing the attempt-provider guard fails 1 test.
- **Security/concurrency:** no new write path; the refused path writes nothing (checks run before any update in the transaction); owner-only `refunds:write` and the ledger row lock are unchanged and still covered by `refunds.test.ts` (authorisation, parallel requests).
- **Evidence (2026-11-14/15, Node 24.22.3, throwaway Postgres 16.13, fresh DB):** focused `admin-orders` + `refunds` 47/47; `npm run verify` green (lint 0 errors/12 known warnings); `verify:full` + `VERIFY_UI=1` -> typecheck ok, unit 629/629, env ok, migrate deploy ok (14), schema diff none, integration 571/571, build ok, smoke 70/0, Playwright 50/50 (22 visual identical). A first `verify:full` run under heavy host load (load avg ~5.7, 23.6 min) timed out 3 browser tests at 90 s (admin owner journey, order tracking, desktop overflow) and passed every other gate; the rerun on a fresh DB passed 50/50 in 5.1 min with no test or timeout change.
- **CI:** `backend/m11-stabilization` @ `7448365` run 43685442437 green (both jobs; browser 28 passed, 22 visual skipped on Linux, F15). Fast-forwarded `backend/development` `5225e44..7448365`; CI run 43686097499 on `backend/development` @ `7448365` green (both jobs). No PR, no deploy, `main` untouched (`55aa848`).
- **Open:** offline refunds of gateway payments have no supported path (business decision, P1-T2); request-only bookkeeping and manual confirmation still open to operations and the legacy session (P1-T2/P1-T5).

### Parallel-session note (2026-11-20)
P1-T3 (F06) was implemented in a second session in the main checkout and is integrated separately (ADR 0020). Everything below was built in a separate worktree on `m11b/work`, pushed as `backend/m11-security-ops`, so the two never shared a working tree or database. Integration order into `backend/m11-stabilization`/`backend/development` is the owner's decision (pending).

### P1-T4 — critical audit fails closed (F07), `b80e6dd`
- **Fix:** `writeAuditTx(tx, …)` (never swallowed) for the successes of `order.update`, `order.refund.requested` (committed with the `Refund` row, before the gateway call), `user.create`, `user.update`, `user.password_reset`, `password.change`, `owner.recover`; library functions take a required actor; rejections/denials/logins stay best-effort. Ratchet `audit-critical-ratchet.test.ts`. ADR 0021.
- **Tests:** `audit-critical.test.ts` injects an `AuditLog` insert failure per action (trigger, disposable DB): order/payment, refund (no ledger row, no gateway call), account create, role change, password reset, own password change all roll back; retries commit exactly one row. Pre-fix: 7/9 fail (the 2 best-effort cases pass both ways).

### P1-T2 — offline payment collections (F04)
- **Fix:** `payments:record` (owner only until the business decides), `offline: { amountPaise = payment amount, method }` required for every payment edit, `Payment.manualMethod/manualRecordedBy/manualRecordedAt` with CHECKs and an immutability trigger (additive migration `20261120083137_offline_payment_record`), UI form with amount/method and confirmation. Offline refunds of gateway payments remain refused. ADR 0024.
- **Tests:** `offline-payments.test.ts` 8/8 (pre-change 5 fail), updated admin-orders/audit-critical/notifications/auth-core, Playwright UPI collection.

### P1-T6 — fail-closed rate limits (F08), `a17e216`
- **Fix:** `consume(…, failMode)` closed by default; per-bucket `RATE_LIMIT_POLICY` (13 closed, 4 public buckets open; unknown = closed); `env:check` refuses `RATE_LIMIT_STORE=memory` in preview/production. ADR 0022 §1.
- **Tests:** `rate-limit-fail-closed.test.ts` (trigger-broken limiter table: admin login with the right password, OTP request, order placement → 429, nothing written; delivery quote 200), `rate-limit-policy.test.ts`. Pre-fix: the 3 sensitive cases fail.

### P1-T5 — shared admin password retired, owner recovery (F05), `e88cc1b`
- **Fix:** shared session = `admin:read`, `enquiries:write`, `wholesale:read`, `fulfilment:read` only; legacy login always off in production (and when the environment cannot be resolved); `env:check` refuses `ADMIN_LEGACY_LOGIN` other than unset/`off`; `admin:bootstrap --reset` → `recoverOwner()` (one transaction: password, reactivate, unlock, revoke the owner's and all shared sessions, `owner.recover` in-transaction). `verify:full` creates its owner before the smoke test. Procedure `RELEASE.md` A1b. ADR 0022 §2.
- **Tests:** `legacy-admin.test.ts` (8), `security-config.test.ts`, updated `auth-core`, `admin-orders`, `admin-users` (real script).

### Dependency fix (F21), `f5c0b0c` (backend) and `4d2a80a` (`main` line)
`next`/`eslint-config-next` 16.4.2 → 16.4.5; `npm audit` 0 on the backend line. `next build` had also started refusing to run on the vulnerable version in this environment.

### P2 — rehearsal, compatibility, build safety, `dd40e8b` (+ `e010159` docs)
- `npm run db:baseline-rehearsal`: 21/21 (main-shaped DB with every `main`-era status; P3005; resolve; 13 migrations; data preserved; the abort-and-recover path for an enum-incompatible value).
- Compatibility measured with each version's own client (F22) → `RUNBOOK-DATABASE.md` matrix, `RELEASE.md` B0 cutover, C2 corrected; `migration-safety.test.ts`; `vercel-config.test.ts` (build never writes, crons protected).
- `main` line: branch `backend/m11-main-build-fix` (`ab07872` DB-free `vercel-build`, `4d2a80a` next 16.4.5) for the owner to promote.

### P3 — business operations, `dd40e8b` `e010159` `58e3504` `6e97269`
- P3-T5 crons + `CRON_SECRET` gate; P3-T3 `inventory:import` (`inventory-import.test.ts`, compare-and-set, idempotent); P3-T1 SMTP (`smtp-delivery.test.ts` 7 against an in-process SMTP server, `smtp-config.test.ts`; ADR 0023); readiness report + payment exceptions (`ops-readiness.test.ts` 6); P3-T6 `tax:signoff-sheet`. CI env-gate cases updated (`2402043`).

## 6. Deployment diagnosis (2026-11-15, read-only)
- **Public site:** `https://velora-valley.vercel.app` = 200 from a clean browser (no Deployment Protection on the production domain), region `sin1`, renders fully, no console errors, all assets 200; 44/44 uncached requests 200 (avg 0.47 s, max 0.92 s). A dark intro loader shows for ~3-5 s before content.
- **What it runs:** `main`'s code. The live route set equals `main`'s tree exactly (`/account`, `/api/health` 404; `/api/orders`, `/api/admin/login` 405); no M9 CSP header. `main` is one commit (`55aa848`); the exact deployed SHA cannot be read (below).
- **Vercel access:** the CLI login (`devarchith5-1566`, team `devarchith-s-projects`) cannot see a `velora-valley` project. It sees only `velora-valley-v3` (`https://velora-valley-v3.vercel.app`), an older prototype (CLI deployments 28+ days old, title "Velora Valley", no `/api/*`). The repo has no GitHub deployment records or Vercel commit statuses, so the production project is owned by another account/team and is not deployed through this repo's GitHub integration (or the integration does not report). Domain assignment, protection settings, build logs and the deployed SHA need that owner's access.
- **Likely causes of "cannot reliably view":** a link to `velora-valley-v3` or to a per-deployment URL (`<project>-<hash>.vercel.app`, which Vercel's standard protection puts behind a Vercel login), or the intro loader. None is a fault of the production domain as observed.
- **Correction applied:** none needed on the production domain; nothing changed in Vercel, `main` or any database.
- **Promotion of `e17a1ba` to `main`: NOT done; mandatory gates fail.** (1) Production not inspected or baselined; the new code needs 29 more tables plus enum columns that `main`'s schema lacks, so deploying before migrations breaks orders/admin and likely the build (catalogue pages read the DB at build). (2) No backup/restore evidence for production. (3) Preview/production isolation unverified (F16). (4) High financial/security findings open (F04, F05, F06, F07). (5) No access to the production Vercel project. **Do not "Redeploy" the current production deployment:** `main`'s `vercel-build` runs `prisma db push` and the seed on every build (F01).
- **Re-check (2026-11-20 04:03 UTC, read-only):** unchanged. Unauthenticated curl + clean browser: `/`, `/shop`, `/business`, `/cart`, `/checkout`, `/contact`, `/our-story`, `/quality`, `/admin`, `/product/premium-cashews`, `/api/products` = 200; `/api/health`, `/account` = 404 (still `main`'s routes); no console errors. `www.velora-valley.vercel.app` fails TLS (not a valid `vercel.app` host), another way to "not see" the site. The Vercel MCP connection is scoped to the same team as the CLI and still sees no `velora-valley` project. `origin/main` = `55aa848` (`vercel-build` still runs `prisma db push` + seed, F01); `origin/backend/development` = `e17a1ba`. No merge, deploy, Vercel change or DB command; promotion still blocked on gates (1)-(5) above.
