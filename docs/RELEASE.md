# Release checklist, rollback plan and operator tasks (M9, M10)

Written for the operator (you) and for agents. Rows marked **operator** change production, Vercel or GitHub settings and are never done by an agent (CLAUDE.md hard rules 1, 2 and 4). Background: ADR 0017 (hardening), ADR 0018 (payments launch), `RUNBOOK-DATABASE.md`.

## A. One-time setup (operator, before M10 goes live)

### A1. Production baselining (M9-T1)
Follow "Production baselining" in `RUNBOOK-DATABASE.md` step by step. Agent role: prepare and review, never run against production.
- [ ] Neon branch `pre-baseline-YYYYMMDD` and a `pg_dump --format=custom` taken; the dump restored into a scratch DB (`npm run db:restore-drill` rehearses exactly this on a disposable copy).
- [ ] Production matches the `0_init` schema: the read-only `prisma migrate diff --from-url "$PROD_UNPOOLED" --to-schema-datamodel <0_init schema> --script --exit-code` from `RUNBOOK-DATABASE.md` step 3 prints an empty migration, exit 0. Anything else: stop, write an ADR. (Not `--to-migrations`: that always differs by the later migrations, F02.)
- [ ] Rehearsal on the Neon branch: `migrate resolve --applied 0_init`, then `migrate deploy` applies every later migration (M2-M10, 13 of them) cleanly; read paths and a test order work on that branch.
- [ ] Production: `resolve --applied 0_init`, then `db:migrate:deploy:production` (needs `APP_ENV=production` and `CONFIRM_PRODUCTION_DB_HOST=<host>`), then `db:schema:diff` = no difference.
- [ ] `admin:bootstrap` for the first owner **before** the new code reaches production: the shared-password login is always off in production from M11 P1-T5, so without an owner account nobody can sign in. Then remove `ADMIN_PASSWORD` from the Production scope (`env:check` warns while it is there) and set `ADMIN_LEGACY_LOGIN=off` in Preview once staff have individual accounts.

### A1b. Owner recovery (M11 P1-T5, operator)
Use when the only owner is locked out, deactivated, has forgotten the password, or the password may be known to someone else.
1. From a trusted machine with the target database's credentials (production needs the db-guard confirmation: `APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host>`): `npm run admin:bootstrap -- --reset --email <owner email>`. The password comes from a hidden prompt (or `ADMIN_BOOTSTRAP_PASSWORD` in the environment, never an argument); policy: 12-200 characters, at least 5 different characters, not containing the email name (`passwordProblem`, `src/lib/auth/password.ts`).
2. In one transaction it sets the new password, reactivates and unlocks the account, ends every session of that owner **and every shared-password session**, and writes `owner.recover` to the audit log (actor `bootstrap-script`). If the audit row cannot be written nothing changes.
3. Sign in at `/admin` with the new password, open Team, review accounts and the activity log (look for `owner.recover` and anything unexpected before it), change other people's passwords or deactivate them if compromise is suspected.
4. Only owner accounts can be recovered this way; any other account is reset by an owner from Team. If no owner account exists any more, `npm run admin:bootstrap -- --email … --name …` creates one (it refuses while an owner exists).

### A2. Environment variables (operator, Vercel)
| Variable | Production | Preview | Notes |
|---|---|---|---|
| `PRODUCTION_DB_HOSTS` | the production DB host | **the same value** | host name only, not secret. Without it a preview build fails (by design) |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | production | a **separate Neon branch** | never the production URL in Preview |
| `PAYMENT_MODE` | `request_only` until launch day, then `razorpay_live` (section E) | `request_only` or `razorpay_test` | `mock` is refused outside dev/test |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `rzp_live_...` at launch only | `rzp_test_...` | live keys outside Production are refused by `env:check` |
| `RAZORPAY_WEBHOOK_SECRET` | the live webhook's secret (16+ chars) | the test webhook's secret | **not** the key secret; required for `razorpay_live`; without it the webhook answers 503 |
| `RAZORPAY_LIVE_ENABLED` | `true` only on launch day | unset | the explicit launch switch; unsetting it (with `PAYMENT_MODE`) is the rollback |
| `CUSTOMER_OTP_MODE`, `NOTIFY_MODE` | unset (off) until the provider is set up; then `email` / `smtp` | unset, or `email` / `smtp` with a test mailbox | mock modes are refused in preview/production (M11 P3-T1, ADR 0023) |
| `SMTP_URL` | `smtps://USER:PASS@host:465` (or `smtp://…:587`, STARTTLS enforced) from the chosen email provider | the provider's sandbox/test credentials | **secret**; URL-encode the password; credentials required outside dev/test |
| `EMAIL_FROM` | e.g. `Velora Valley <orders@your-domain>` on a domain verified with the provider (SPF/DKIM) | same | business decision: sender name and address |
| `SESSION_SECRET`, `CRON_SECRET` | set, random, different per scope | set | `SESSION_SECRET` also keys the rate-limit IP hashes |
| `SELLER_GSTIN` | set when invoices start | — | with accountant-approved `TaxRate` rows |
| `RATE_LIMIT_STORE` | unset (database) | unset | `memory` only to debug locally; `env:check` refuses it in preview/production (M11 P1-T6) |
| `LOG_LEVEL` | unset (info) | unset | `debug` temporarily if needed |

### A3. Preview isolation check (M9-T2, operator)
The code half is enforced by `env:check`. The settings half only you can see:
- [ ] Project → Settings → Environment Variables: Preview scope has its own `DATABASE_URL`/`DATABASE_URL_UNPOOLED` (Neon branch or integration branch-per-preview) and `PRODUCTION_DB_HOSTS`; the production URL appears only in the Production scope.
- [ ] Or disable previews (Settings → Git → ignored build step) until a preview database exists.
- [ ] Open a preview deployment and run `GET /api/internal/test-environment` (must be 404) and `GET /api/health` (200).
- [ ] Record the result in `PROGRESS.md` (closes blocker 1).

### A4. Branch protection (M9-T8, operator — GitHub settings)
For `main` and `backend/development` (Settings → Branches → rules, or Rulesets):
- [ ] Require status checks to pass: **both** CI jobs, `Typecheck, unit tests, env gate` and `Migrate, integration, build, API smoke (disposable Postgres)`; require branches to be up to date.
- [ ] Block force pushes and deletion.
- [ ] `main`: restrict who can push (only you); keep it out of agents' reach.
- [ ] `backend/development`: allow pushes by the maintainer so the fast-forward workflow in CLAUDE.md still works (a ruleset that forbids direct pushes would force pull requests, which the workflow deliberately avoids; if you prefer PRs, say so and the workflow changes).
- [ ] Verify with a throwaway branch: a push that breaks the type check must show as blocked from merging.

### A5. Monitoring (M9-T5, operator)
- [ ] Uptime monitor on `https://<domain>/api/health` (1 min interval; alert on 2 consecutive failures). Expect `{"ok":true}`.
- [ ] Log drain or alerting on structured events (all JSON lines): `request.unhandled_error`, `payments.*`, `reconcile.*`, `expire.*`, `rate_limit.database_unavailable`, `audit.write_failed`, `health.database_unreachable`. Vendor is your choice (ADR 0017).
- [ ] Cron entries (plan permitting, `vercel.json` has none yet): `/api/internal/orders/expire` and, once notifications are on, `/api/internal/outbox/process`, both with `CRON_SECRET`. Payment reconciliation is the operator script `npm run payments:reconcile` until the M10 cron route exists.

### A6. Header score (M9-T3, after the first deploy of M9)
- [ ] Scan the production URL with securityheaders.com and Mozilla Observatory; record the grade in `PROGRESS.md`. Expected: A/A+ on headers; `script-src 'unsafe-inline'` is the known deduction (ADR 0017).
- [ ] Browse the shop, checkout (COD), an order page and `/account` with the browser console open: no "Refused to…" CSP errors. Before M10 goes live, repeat with a Razorpay test payment (the CSP already allows Razorpay).

### A7. Scheduled jobs (M11 P3-T5, F13; operator confirms the Vercel plan)
`vercel.json` now schedules three bearer-protected jobs on the **production** deployment: order expiry `/api/internal/orders/expire` every 15 minutes (cancels unpaid/failed online orders past the payment window and releases stock; also expires quotes), payment reconciliation `/api/internal/payments/reconcile` every 15 minutes at :07/:22/:37/:52 (gateway sweep, late captures, refunds), notification outbox `/api/internal/outbox/process` every 10 minutes (does nothing while `NOTIFY_MODE` is off).
- [ ] `CRON_SECRET` (24+ random characters) in the Production scope: `env:check` now **fails a production build without it**, because the routes answer 404 to Vercel Cron and every job would silently do nothing.
- [ ] **Plan check:** these schedules run more than once a day. Confirm the production project's Vercel plan allows that before promoting; if the plan only allows daily jobs, the deployment is rejected, and the fallback is an external scheduler (e.g. an uptime service) calling the same three URLs with `Authorization: Bearer $CRON_SECRET` at the same frequency.
- [ ] After the first production deploy: Vercel → Project → Cron Jobs lists the three jobs; each job's logs show `200` with counts. `npm run payments:reconcile` remains the manual fallback.

### A8. Stock initialisation (M11 P3-T3, F11; quantities come from the business)
Until a variant is tracked, availability is the manual `inStock` flag and nothing prevents overselling. To start counting:
1. [ ] Staff count stock and fill a CSV with the header `sku,stock` (units on hand, whole numbers, one row per variant; SKUs as in the admin dashboard).
2. [ ] Dry run (changes nothing): `npm run inventory:import -- --file counts.csv` against production needs the db-guard confirmation (`APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host>`). It prints, per SKU, `start_tracking` / `adjust` / `unchanged` with current → new counts, refuses unknown SKUs, duplicates, non-integers and counts below what open orders hold, and lists active variants that are still untracked and not in the file.
3. [ ] Apply in a quiet period: add `--apply --reason "Opening count YYYY-MM-DD"`. Each row is its own transaction through the stock ledger (actor `system`/`inventory-import`), compare-and-set against the count seen in the plan: a row whose stock moved meanwhile is refused (`stock_changed`), never overwritten; re-run the dry run and apply again. Re-running the same file changes nothing.
4. [ ] Check the admin low-stock list and a product page; tracked variants with 0 units show as unavailable.

### A9. GST sign-off (M11 P3-T6, F14; accountant)
1. [ ] `npm run tax:signoff-sheet > gst-signoff.csv` (read-only) lists every HSN code used by an active pack (and `DELIVERY`), the products using it and any rate already recorded. It never proposes a rate.
2. [ ] The accountant fills `approved_rate_percent`, `effective_from`, `approved_by`, and confirms: the rounding rule (half-up per line, ADR 0015), whether e-invoicing (IRN) applies at the business's turnover, and the credit-note process (not built; an invoiced order cannot be cancelled until it is).
3. [ ] An owner enters each approved row under Admin → Settings → GST rates (append-only), and `SELLER_GSTIN` is set in Production. `npm run ops:readiness` then shows both tax checks `ok`; issue one invoice on a test order and have the accountant check the PDF.

## B0. First promotion of the backend onto production (one-time cutover, M11 P2-T3)
`main`'s code cannot take orders on the migrated schema and the backend cannot run on `main`'s schema (`RUNBOOK-DATABASE.md` "Release compatibility matrix"), so this release is a short, planned ordering outage, not a rolling update.
1. [ ] Gates in section B steps 1-3 green; A1 rehearsal done on a Neon clone of production (real data); `npm run db:baseline-rehearsal` green on a disposable DB.
2. [ ] `main` carries the DB-free build first (branch `backend/m11-main-build-fix`, F01), so no later deploy of old code can `db push` over the migrated schema.
3. [ ] An owner account exists in production (`admin:bootstrap`, A1/A1b): the shared-password login is off in production from this release.
4. [ ] Production environment variables for the new code are set (A2: `CRON_SECRET`, `PRODUCTION_DB_HOSTS`, `SESSION_SECRET`, …); `ADMIN_PASSWORD` may remain until step 9.
5. [ ] The backend cannot be pre-built against production: its build prerenders product pages from the database and fails on `main`'s schema (`Variant.trackInventory` missing; verified 2026-11-20), and a deployment's build and runtime share one set of variables, so a build against a migrated clone would also *run* against the clone. Plan the outage as "migration + one build" (the last `verify:full` build took ~3-5 minutes locally).
6. [ ] Low-traffic window; Neon branch `pre-cutover-YYYYMMDD` (this branch is the only way back to `main`).
7. [ ] Baseline + migrate (A1: `resolve --applied 0_init`, `db:migrate:deploy:production`, `db:schema:diff`), then **immediately** deploy the backend commit to Production (promote `main` to it). Between the migration and the new deployment going live, catalogue pages keep working but checkout and the admin order list fail.
8. [ ] Read-only smoke (B7), an admin sign-in with the owner account, one real COD test order placed and cancelled by staff.
9. [ ] Remove `ADMIN_PASSWORD` from Production. Record SHAs, the backup branch and the outage window in `PROGRESS.md`.
- **Rollback during the window:** if the build in step 7 fails, production is `main` on a migrated DB (orders broken): either finish the promotion or restore the step-6 branch (repoint `DATABASE_URL`) and keep `main`. After promotion, rolling back to `main` also requires restoring the step-6 branch and loses orders taken since; prefer fixing forward.

## B. Release checklist (every release to production)
Agent prepares, operator promotes. `main` is promoted only by the operator.
1. [ ] `backend/development` is green in CI at the SHA being released; `npm run verify` and (milestone releases) `verify:full` with `VERIFY_UI=1` pass locally; quote the summary lines.
2. [ ] `npm audit` 0; `npm run lint` clean (warnings ≤ the ratchet).
2b. [ ] `npm run ops:readiness` with the target environment's variables (operator shell; read-only) shows no `blocker`; every `action` is either accepted for this release or resolved (M11; the same report is `GET /api/admin/readiness` for owners).
3. [ ] Migrations in the release listed (`git diff main..backend/development --stat -- prisma/migrations`); each is additive or has an ADR plus rollback note in `RUNBOOK-DATABASE.md`.
4. [ ] **Back up first:** Neon branch `pre-release-YYYYMMDD-<sha>` from production.
5. [ ] Apply migrations to production **before** the app: `db:migrate:deploy:production`; then `db:schema:diff` = no difference.
6. [ ] Promote `main` (operator) → Vercel builds (`vercel-build` runs `env:check`; it fails closed on unsafe configuration).
7. [ ] Post-deploy smoke, read-only, against production: `GET /api/health` 200; `GET /api/products` count; a page load; response headers present. **Do not run the write smoke test (`test:api`) or any test suite against production**; they refuse to.
8. [ ] Watch logs for 30 minutes for `request.unhandled_error` and `payments.*`.
9. [ ] Record the release in `PROGRESS.md` (SHA, migrations, backup branch name).

## C. Rollback plan
Decide fast: if customers are affected and the cause is not understood within 15 minutes, roll back the application first.
1. **Application:** Vercel → Deployments → the previous good deployment → *Promote to Production* (instant, no rebuild). Or revert on `main` and let it rebuild.
2. **Database:** within the backend line, migrations are additive (enforced by `tests/unit/migration-safety.test.ts`), so the previous **backend** deployment works with the new schema (this is why migrations ship first and are never destructive in the same release). Do **not** roll the schema back to "fix" an app problem. **Exception: the first cutover from `main` (B0)** — `main`'s code cannot run on the migrated schema; going back to it means restoring the pre-cutover database.
3. **Data damage** (bad write, wrong update): restore from the Neon branch taken in step B4 into a *new* branch, compare, then copy the affected rows back; never restore over production without a written plan. For a catastrophic loss use Neon point-in-time restore to a new branch, validate with the drill checklist (`db:restore-drill` lists what to compare), then repoint `DATABASE_URL`.
4. **Payments:** if payment behaviour is suspect, set `PAYMENT_MODE=request_only` (redeploy): checkout falls back to "request" orders; nothing is lost and no gateway call is made. Since M10, removing `RAZORPAY_LIVE_ENABLED` (or setting `PAYMENT_MODE=request_only`) is the rollback; see section E4 for what happens to payments already in flight.
5. **Notifications / sign-in:** unset `NOTIFY_MODE` / `CUSTOMER_OTP_MODE`.
6. **After any rollback:** write what happened in `PROGRESS.md` and an ADR if a design assumption was wrong.

## D. Targets (proposed; need your confirmation: ADR 0017 follow-up)
- **RPO** (data you can lose): ≤ 5 minutes with Neon point-in-time restore on a plan with a ≥ 7-day history window (confirm the plan; the free tier's window is shorter); ≤ 24 hours if relying on daily `pg_dump` only.
- **RTO** (time to be serving again): ≤ 1 hour for an application rollback or a Neon branch restore of this database size (a few hundred MB at most for years at this volume); the local drill restores a copy in about a second, so the provider's branch/restore latency dominates.
- Drill cadence: `npm run db:restore-drill` after every milestone that adds tables (it is the rehearsal), and a production restore drill (Neon branch → validate → delete) once before M10 goes live and quarterly after.



## E. Payments launch (M10, operator; ADR 0018)
The code is finished and tested against a deterministic fake gateway; **nothing below has been run against Razorpay**. Do E1 in a preview first. No live key is ever put in a preview, a test, a document or a log.

### E1. Test-mode run in a preview with an isolated database (M10-T6)
Pre-conditions: A3 done (preview has its own database and `PRODUCTION_DB_HOSTS`), Razorpay account in test mode.
- [ ] Preview scope: `PAYMENT_MODE=razorpay_test`, `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (you choose it, 16+ random characters), `CRON_SECRET`. The build's `env:check` passes.
- [ ] Razorpay Dashboard (test mode) -> Webhooks -> add `https://<the preview host>/api/payments/razorpay/webhook`, the same secret, events: `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. (A preview behind Vercel Deployment Protection needs a protection bypass for this path, or use a stable staging alias.)
- [ ] **Happy path:** place an order, pay with a Razorpay test card/UPI -> the order page shows paid; Dashboard -> Webhooks shows the delivery answered `200` with `outcome: "paid"`; the admin order shows the `gateway` event.
- [ ] **Dropped browser:** place an order, pay, **close the tab before the redirect**: the webhook still marks it paid. Then disable the webhook in the Dashboard, repeat, and confirm `GET /api/internal/payments/reconcile` (`Authorization: Bearer $CRON_SECRET`) marks it paid once it is 10 minutes old (`swept >= 1`, `paid >= 1`).
- [ ] **Failed payment:** pay with Razorpay's failing test card -> the order stays `awaiting_payment`, the attempt is `failed`; paying again with a good card marks it paid.
- [ ] **Duplicate delivery:** Dashboard -> Webhooks -> resend an event: `200` with `result: "duplicate"`, no second order event.
- [ ] **Refunds:** as an owner, `POST /api/admin/orders/<id>/refunds` with a partial amount, then the rest; `GET` the ledger and compare it with the Dashboard to the paisa; the order becomes `refunded` only after the last one. Refund once from the Dashboard instead and confirm it appears as `source: gateway`.
- [ ] **Things the fake gateway cannot prove (confirm and write down):** the refund API accepts `receipt` and echoes it; whether Razorpay supports an idempotency header on refunds (a lost response is reconciled by receipt today); `GET /payments/:id/refunds` pagination; the orders `receipt` filter (open since M2); the auto-capture setting (E2).
- [ ] Record the result and the Razorpay delivery log in `PROGRESS.md`.

### E2. Decisions needed before launch
- **Auto-capture:** set Razorpay to auto-capture. With manual capture, `payment.authorized` is acknowledged but not acted on and uncaptured authorizations auto-release after the gateway's window.
- **Refund policy and approvals:** only an **owner account** can refund (`refunds:write`), with a written reason, and every attempt is audited. Decide who is an owner, whether a second approver is needed above some amount, the refund window and shipping-fee treatment.
- **Cash on delivery after launch:** unchanged (request-only orders; refunds of cash are outside the system).
- **Settlement reconciliation owner:** who compares Razorpay settlements and payouts with orders each week (`npm run payments:reconcile -- --audit-refunds` compares refunds only; settlements and fees are Razorpay's report against the accountant's books).
- **Credit notes:** a refunded, invoiced order keeps its tax invoice until credit notes exist (accountant decision, M7 gap).
- **Reconciliation schedule:** call `GET /api/internal/payments/reconcile` every 5-10 minutes (a Vercel Cron on a plan that allows it, or an external scheduler sending the bearer). There is deliberately no `vercel.json` cron entry in the repo (the plan and Vercel settings are yours). Without a schedule the webhook alone carries payments and `npm run payments:reconcile` is manual.

### E3. Live launch checklist (M10-T7)
- [ ] Razorpay KYC and settlement account approved; live mode enabled on the account.
- [ ] A1-A5 complete: production baselined, preview isolation, branch protection, monitoring on `/api/health`, production restore drill done.
- [ ] E1 passed; E2 decisions written down.
- [ ] Production scope: `RAZORPAY_KEY_ID=rzp_live_...`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (a **different** secret from test), `CRON_SECRET`; still `PAYMENT_MODE=request_only`. Create the live webhook (same path, same six events) for the production host.
- [ ] Release checklist B done for the M10 release (migration `20261119090000_m10_refunds_webhooks` is additive: apply it before the app).
- [ ] Reconciliation schedule running (E2) and alerts on the log events `webhook.failed`, `webhook.orphan_capture`, `webhook.invalid_signature` (a burst), `payments.verify_*` and `refunds.*`.
- [ ] **Launch:** set `PAYMENT_MODE=razorpay_live` and `RAZORPAY_LIVE_ENABLED=true`, redeploy (`env:check` refuses live without the keys, the webhook secret or the switch). Place one real low-value order yourself, confirm the webhook delivery answered `200` with `outcome: "paid"`, refund it through the admin API, confirm the ledger and the Razorpay refund agree.
- [ ] Watch the logs for 24 hours: `webhook.*`, `payments.*`, `refunds.*`, `reconcile.*`.

### E4. Rolling back the launch (reversible by configuration alone)
1. Set `PAYMENT_MODE=request_only` (or remove `RAZORPAY_LIVE_ENABLED`) and redeploy: new orders become request orders; no gateway call is made for them.
2. **Payments already in flight still need settling:** outside a Razorpay mode the webhook answers `503`, so the gateway keeps retrying for about 24 hours. Restore live mode briefly (or run `payments:reconcile` with the live keys in a guarded operator shell) to settle them. Orders created under live mode are never touched by another mode (`mode_mismatch`), so nothing is mis-applied while rolled back.
3. Refunds of live payments need live mode too (a `razorpay_test` or `request_only` server refuses them).
4. Record what happened in `PROGRESS.md`.
