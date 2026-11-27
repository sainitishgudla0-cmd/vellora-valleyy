# M12 independent audit — findings, fixes, evidence, blockers

Started 2026-11-22 from `backend/development` @ `0ec05ea` (M11 RC + docs). Branch `backend/m12-audit-fixes`, worktree
`~/Developer/Velora-Valley-m12`. Decisions: ADR 0025. No separate M12 audit document existed in the repository; the
eight suspected defects (VA-01..VA-08) came from the task brief and were each checked against the code before any change.

## Summary
| Id | Suspected defect | Verdict | Severity | Fix |
|---|---|---|---|---|
| VA-01 | Cross-account export/erasure | **Confirmed** | High (privacy, data integrity) | Orders matched by account, or unclaimed guest orders by verified email |
| VA-02 | Silent checkout quantity truncation | **Confirmed** | Medium | Merged over-cap lines → `422` |
| VA-03 | Stale wholesale approval / credit checks | **Confirmed** | High (credit exposure) | Account locked and re-read inside the order transaction |
| VA-04 | Non-atomic admin user/password changes | **Confirmed** | Medium | One transaction; password validated first; CAS on self-change |
| VA-05 | Financial configuration audits not transactional | **Confirmed** | Medium (evidence) | 12 actions made critical (`writeAuditTx`) + ratchet |
| VA-06 | Concurrent OTP issuance | **Confirmed** | High (brute force, mail bombing) | Per-address advisory lock around limits + issue |
| VA-07 | Unicode invoice rendering | **Confirmed** | Medium (legal document legibility) | WinAnsi mapping + Indic transliteration |
| VA-08 | Origin/proxy validation weaknesses | **Partly confirmed** | Medium off Vercel, none on Vercel | Trusted-proxy client address; Origin check reviewed, unchanged |
| M12-A01 | (new) Money above INT4 range → 500 | **Confirmed** | Low | `422` before insert (orders, quote pricing) |

## Findings in detail
**VA-01.** `exportCustomerData`/`eraseCustomer` matched `customerId = A OR email ILIKE A.email`. Checkout lets a signed-in
customer B type any contact email, and claim-by-token links a guest order to B whatever its email. So A's export
contained B's order (B's name and address), A's erasure anonymised B's order and **unlinked it from B's account**, and an
open order of B's blocked A's erasure. Reproduced by 4 tests (`m12-audit.test.ts` VA-01). Root cause: the email branch
did not require `customerId IS NULL`. Fix: `src/lib/account/erasure.ts` `orderWhere`.

**VA-02.** `createOrder` merged duplicate lines with `Math.min(cap, …)`: `[{v,30},{v,30}]` became one line of 50 and
the order was accepted (201) for fewer units than requested. The storefront cart cannot send duplicates, but the API
can. Fix: merge exactly, refuse over-cap with `422 { fields.items }`.

**VA-03.** `requireBusiness` loads the account before the order transaction; `accountPriceLines(account)` and
`creditCheck(account)` closed over that snapshot. The row lock was taken only for credit accounts and the row was not
re-read, so a suspension, a lowered credit limit, a switch from prepaid to credit, or a new price list committed in the
window was ignored. Reproduced by 3 tests (order placed for a suspended account; for a lowered limit; for new credit
terms). Fix: `lockActiveBusinessAccount` in `createOrder` (`FOR UPDATE` + re-read + approved check) for every
wholesale order and quote acceptance; hooks receive the locked row. Parallel credit orders still cannot overrun the
limit (test: 6 parallel orders with room for 2 → exactly 2 × 201, 4 × 409).

**VA-04.** `PATCH /api/admin/users/[id]` ran `updateUser` (commit) and then `resetPassword` (second transaction).
`{ role: "viewer", password: "short" }` returned 422 while the demotion and the session revocation had already
committed; a failed `user.password_reset` audit insert likewise left the role change applied. Fix: one transaction;
the password is validated and hashed before anything is written. `changeOwnPassword` now compare-and-sets on the
verified hash (a parallel change or an owner reset can no longer be silently overwritten).

**VA-05.** GST rates, shipping fees/serviceability, price lists and tiers, retail prices, MOQ/case packs, business
account terms/credit limits and enquiry conversion (which can create an approved credit account) were audited with the
best-effort `writeAudit` after commit. With the audit insert failing (trigger injection), every one of them committed
without evidence. Fix: actions added to `CRITICAL_AUDIT_ACTIONS` and written with `writeAuditTx` in the change's
transaction; price changes record `from`/`to` under a row lock (`variant.price`). The ratchet
(`tests/unit/audit-critical-ratchet.test.ts`) pins each action to its owning module. Reviewed and left as is: quote
pricing (its `QuoteEvent` rows are written in the same transaction), invoice issue (the gap-free `Invoice` row is the
record), stock (`InventoryMovement` ledger).

**VA-06.** `issueOtp` checked the hourly cap and the 30-second cooldown with a plain read, then retired old codes and
inserted the new one in a batch transaction. 10 parallel requests for one address issued **6** live codes (6 emails,
6 × 5 guesses); 20 parallel requests spread past the cooldown got **19** codes against a cap of 5. Fix: checks, retire
and insert run inside a transaction holding `pg_advisory_xact_lock` on the address hash; the email is sent after commit
(failure still deletes the code). After the fix: exactly 1 code; never more than 5 per hour.

**VA-07.** `esc()` replaced everything outside Latin-1 with `?` per UTF-16 unit. Reproduced on the pre-fix renderer:
a Telugu buyer name printed `?????????? ??????`, `D’Souza – Café` printed `D?Souza ? Café`, and a decomposed `José`
printed `Jose?`; `fit()` could split surrogate pairs. Fix: `src/lib/invoices/pdf-text.ts` (`toPdfText`): NFC, rupee
sign → `Rs.`, typographic punctuation → its WinAnsi glyph, Devanagari/Bengali/Gurmukhi/Gujarati/Odia/Tamil/Telugu/
Kannada/Malayalam transliterated through one ISCII-ordered table (`శ్రీనివాస్ రెడ్డి` → `Shriinivaas Reddi`), Latin
diacritics folded, other characters one `?` each; `fit()` counts drawn glyphs. One existing test asserted the defect
(`అశ` → `??`) and now asserts `Asha`. Limitation: the PDF shows a Latin transliteration, not the native script
(an embedded Unicode font with shaping would be needed for that).

**VA-08.** (a) Rate-limit key = first `X-Forwarded-For` entry. Correct on Vercel (Vercel overwrites the header), but on
any other host (the Render GitHub app is installed on the repository; `next start` behind nginx) a client can rotate
the value per request and bypass the sign-in-code, admin-login and checkout limits. Fix: `src/lib/client-ip.ts`
(Vercel: the address Vercel sets; elsewhere `TRUSTED_PROXY_HOPS`, default 1, from the right; too few hops → one shared
`untrusted` key; `X-Real-IP` ignored off Vercel). (b) Origin check: compared with `X-Forwarded-Host`/`Host`, no scheme.
Not a defect: a cross-site browser request cannot carry a custom `X-Forwarded-Host` without a CORS preflight the app
never grants, and session cookies are `Secure`; a scheme check would risk refusing legitimate requests behind TLS
proxies. Unchanged, documented in ADR 0025.

**M12-A01 (new).** Money columns are INT4 paise. A wholesale order of 1,000 × ₹50,000 (5e9 paise) failed the insert and
returned **500**; quote pricing likewise. Fix: refuse with `422` before writing.

## Admin portal acceptance (M12 release step 2)
| Requirement | Where | Verified by |
|---|---|---|
| Staff email/password login, wrong password refused without a session | `/admin` | `admin-portal.spec.ts` (phone), `admin.spec.ts`, `admin-auth.test.ts` |
| Individual accounts, roles, permissions enforced by the server | Team tab; `requireAdmin` on every route | `admin.spec.ts` (viewer), `admin-portal.spec.ts` (operations: no Team, 403 on users/tax/refunds), role × route matrix in `admin-users.test.ts` |
| Owner authentication and recovery | owner role; `admin:bootstrap --reset` (RELEASE A1b) | `admin-users.test.ts`, `legacy-admin.test.ts` |
| Products and inventory | Products tab (price, availability, stock tracking/adjust) | `admin-operations.spec.ts`, `admin-inventory.test.ts` |
| Orders and permitted payment actions | Orders tab, order page | `admin-operations.spec.ts`, `admin-orders.test.ts`, `offline-payments.test.ts`, `refunds.test.ts` |
| Enquiries | Enquiries tab (status) | `admin-portal.spec.ts` |
| Wholesale operations | Wholesale tab | `admin-operations.spec.ts`, `wholesale-admin.test.ts` |
| Reporting | Operations tab: **Sales summary (added in M12)**, readiness, payment exceptions, failed notifications, low stock | `m12-audit.test.ts` (sales), `admin-portal.spec.ts`, `ops-readiness.test.ts` |
| Logout and session management | Sign out; Account tab sessions; Team (others' sessions) | `admin-portal.spec.ts`, `admin.spec.ts` |
| Mobile usability | 390 px: login, dashboard, operations fit; every tab reachable | `admin-portal.spec.ts` |
Gap found and closed: there was no sales reporting (only operational checks). `src/lib/ops/sales-report.ts` + the *Sales*
section (read-only, `admin:read`, same styles as the existing tab). Storefront untouched.

## Other areas inspected (no defect found)
Order/payment state machine and admin order edits; `/verify` (signature before any write, server-side capture lookup,
amount/currency/mode checks); webhook (raw-body HMAC, dedupe, orphan captures); refunds (owner-only, row lock,
balance); stock holds and expiry; guest invoice/order token checks (`safeEqual`); account and business route ownership
scoping (addresses, orders, invoices, quotes); cron routes (24+ char bearer, constant-time compare, 404 when unset);
test-only routes (404 outside disposable dev/test with mock sender); email templates (every variable HTML-escaped);
security headers; `npm audit` 0.

## Tests and evidence
- New: `tests/integration/m12-audit.test.ts` (25 tests), `tests/unit/m12-audit.test.ts` (12 tests). **Against the
  pre-fix code: 19 of the first 24 integration tests failed** (the 5 that passed are the controls: own/guest export, exact
  merge, parallel credit, combined change, sign-in); the unit tests target modules that did not exist, and the pre-fix
  renderer output for VA-07 is quoted above.
- After the fixes (Node 24.22.3, disposable Postgres 16 on 127.0.0.1:54331): `npm run verify` → typecheck ok, lint
  0 errors / 12 warnings (unchanged ratchet), unit **672/672**, env gate ok; `npm run test:integration` **659/659**
  (634 existing + 25 new); `npm audit` 0.
- `verify:full` + `VERIFY_UI=1` on a fresh disposable DB (`velora_m12_full`): all gates passed — migrate deploy, schema
  drift none, seed, integration 658/658, build, API smoke 70/0, Playwright 38 passed / 22 visual skipped (this worktree
  has no local baselines; the CI `visual` job compares against the approved commit). It ran before the final review fix
  (stock + price in one transaction, +1 test); unit and integration were re-run on the final code (672 / 659).
- Release rehearsals on the final code (`04271ca`, disposable DB `velora_m12_full`): `db:baseline-rehearsal` all checks
  passed (baseline + redeploy applies every migration, schema diff none); `db:restore-drill` passed (dump → restore into
  a scratch DB → checksums/migrations/drift equal); `db:migrate:status` 15 migrations, up to date; `test:perf` against a
  local production build: every page/API p95 ≤ 16 ms (budget 2,000 ms), 40 simultaneous checkouts for 5 tracked units →
  5 placed, 35 × 409, 0 errors (no oversell). Accessibility spec ran inside the browser suite (passed).
- Self-review (`/review`): one medium finding — a combined stock + price request committed the stock change before the
  price transaction, so a failed price audit returned 500 after the stock moved (a retry would double it). Fixed:
  `updateVariantInventory({ alsoInTransaction })`; regression test added.
- 
## Progress
| Step | Status | Evidence |
|---|---|---|
| Audit VA-01..VA-08 + independent review | done | this report |
| Fixes + regression tests | done | commit `8ed5b3f` on `backend/m12-audit-fixes` |
| Local gates | done | see "Tests and evidence" |
| CI on `backend/m12-audit-fixes` @ `8ed5b3f` | **green** | run 45073494195 (https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/45073494195): checks; migrate + integration + build + smoke 70/0 + browser 38 passed / 22 visual skipped; `visual` job 22/22 identical to approved `1aefdd8` |
| Integration into `backend/development` | **done** | fast-forward `0ec05ea..8ed5b3f` (no concurrent commits, no merge commit, no force push); CI run 45074396960 green, all three jobs (https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/45074396960) |
| `main` promotion | **done 2026-11-26**: fast-forward `55aa848..d78cd50` (no force, no merge commit); GitHub `main` = `d78cd50`; CI run 45933944221 green (all three jobs); no GitHub deployment and no Vercel/Render check run triggered | https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/45933944221 |
| Vercel staging / production | infrastructure ready; **no deployment exists** (`vercel deploy` is denied to agents by `.claude/settings.json`; owner command below) | "Staging and production infrastructure" |
| Release candidate | `backend/development` = `backend/m12-audit-fixes` = **`39eff03`**; CI green: run 45103950272 (branch) and 45104929932 (`backend/development`), smoke 70/0, browser 39 passed / 22 visual skipped, visual job 22/22 identical | https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/45104929932 |

## Vercel scope (corrected 2026-11-22)
An earlier version of this report said the account was on Hobby. That was wrong: it read `billing.plan` from the
personal **user** record (`hobby`), not from the team that owns the projects. The deploying scope is the team
**`devarchith-s-projects`** (`team_auKmjkfzNRCJAFGD5Men7gmo`): `billing.plan = "pro"`, status active, no trial, current
period 2026-11-22 → 2026-12-25, role OWNER (`vercel api /v2/teams/team_auKmjkfzNRCJAFGD5Men7gmo`). It is the only
scope the CLI can see and it holds the existing `velora-valley-v3` (not to be modified). Pro allows commercial use and
per-minute crons, so the plan is not a blocker. The Vercel **MCP** connection still answers 403 for this team until the
owner approves team access (`authorize_team_access` link); the CLI is signed in and is used meanwhile.

## Launch blockers (exact; each needs the owner)
1. (resolved) Vercel plan: the team scope is Pro, see above.
2. **`main` promotion preflight (2026-11-22, owner-authorised).** Evidence that no external deployment builds from
   this repository: across ~2 weeks of pushes (72 commits on `backend/**`) and on `main`'s own commit, the Vercel and
   Render GitHub apps have only ever created empty queued check suites (0 check runs); the repository has **no**
   GitHub deployments, no environments and no commit statuses. A Git-connected Vercel project creates GitHub
   deployments for every push, and a Render auto-deploy reports a check, so neither appears to be linked. Webhooks
   cannot be listed (needs repo admin). Isolation added anyway, from the repository side: `vercel.json`
   `"git": { "deploymentEnabled": false }` (Vercel creates no Git-triggered deployment for ANY project connected to this
   repository, whatever its dashboard build command; pinned by `tests/unit/vercel-config.test.ts`), and the head commit
   message carries `[skip render]` / `[skip deploy]` (Render's documented skip phrases). The new project deploys only
   through the CLI. Builds never write to a database (`vercel-build` = env gate + `prisma generate` + `next build`).
   Residual risk: a Render service with auto-deploy whose skip handling ignores the head commit (Render's docs do not
   say which commit of a multi-commit push is checked); no Render activity has ever been reported on this repository.
3. **Database.** A new Neon Postgres (Vercel Marketplace) per environment: staging and production on separate
   projects or branches; production on a plan with point-in-time restore. Creating it accepts the provider's terms and
   picks a (possibly paid) plan; it waits on blocker 1 (the database is attached to the new Vercel project).
4. **Business inputs that must not be invented** (unchanged from M11): email provider + verified sender domain
   (`SMTP_URL`, `EMAIL_FROM`; without them customer sign-in and order emails stay off), accountant-approved GST rates
   per HSN and `SELLER_GSTIN`, opening stock counts, shipping rules (serviceable pincodes, fees), offline-payment policy
   (ADR 0024), the owner's admin email (the owner chooses the password at `admin:bootstrap`), Razorpay **test** keys and
   test webhook secret for the staging payment run.

## Staging and production infrastructure (created 2026-11-22, team `devarchith-s-projects`, Pro)
| Item | State | Evidence |
|---|---|---|
| Project `velora-valley-store` (`prj_CFO7y0MfsqcpQ5XKdSA76HIavIaH`) | created; **no Git connection** (deploys only when run explicitly, so no push can deploy it); Node 24.x; Next.js; region `sin1` from `vercel.json`; Vercel Authentication on all deployments | `vercel api /v9/projects/…` |
| Staging DB `velora-staging` (Neon Free, `store_1EPOvQkW3IDfKGo8`, us-east-1) | connected to **Preview + Development only**; 15 migrations applied, `migrate diff` exit 0, `migrate status` up to date; catalogue seeded once explicitly (30 products / 40 variants); staging owner `staging-owner@velora-staging.invalid` (password generated locally, never printed) | guarded `db:migrate:deploy` with the staging hosts declared disposable |
| Production DB `velora-production` (Neon Free, `store_GWgcfWoRXFdKCGv8`, ap-southeast-1 Singapore) | separate Neon project, connected to **Production only**; empty (not migrated) | `NEON_PROJECT_ID` differs from staging |
| Env (Preview) | `PAYMENT_MODE=request_only`, `ADMIN_LEGACY_LOGIN=off`, `SESSION_SECRET`, `CRON_SECRET` (sensitive, generated), `PRODUCTION_DB_HOSTS` = production host; no `ADMIN_PASSWORD`; notify/OTP unset (no email provider) | `vercel env ls` (names only) |
| Env (Production) | only the Neon variables and `PRODUCTION_DB_HOSTS` so far | |
| Staging deployment | **not yet created**: `.claude/settings.json` denies `vercel deploy` to agents (deliberate rail), so the owner runs it: `cd ~/Developer/Velora-Valley-m12 && vercel deploy --scope devarchith-s-projects` (preview). After the owner reported running it, no deployment appeared within 10 minutes (`vercel ls velora-valley-store`) | |

## Owner commands (exact; each refused to the agent by repository safety rules)
1. Staging deploy (Preview, not production), from the worktree linked to `velora-valley-store`:
   `cd ~/Developer/Velora-Valley-m12 && vercel deploy --scope devarchith-s-projects`
2. Promote `main` (fast-forward to the CI-green release; refuses if `main` moved):
   `cd ~/Developer/Velora-Valley-m12 && git fetch origin && test "$(git rev-parse origin/main)" = 55aa848180c4ba202a488c85d7d24526e2e1cc4e && git merge-base --is-ancestor origin/main 39eff033f00c496bb2794a6437d6a8cbd8c5e0ac && git push origin 39eff033f00c496bb2794a6437d6a8cbd8c5e0ac:refs/heads/main`
3. After staging acceptance passes: production migrations are also denied to the agent
   (`db:migrate:deploy:production`); the owner runs them with `APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=ep-proud-bread-azqtrw6g.c-3.ap-southeast-1.aws.neon.tech`.
State verified after the owner reported running 1 and 2 (2026-11-23): `main` still `55aa848` on GitHub, no deployment
in `velora-valley-store`. Neither took effect; the outputs were not available to the agent.

## Permission blocker (2026-11-26, owner-authorised operations still refused)
The owner explicitly authorised the agent to push `main` and deploy staging. Verified before trying: release
`d78cd50` (= `39eff03` + docs), CI run 45107590299 green, clean worktree, `main` `55aa848` is an ancestor, `vercel.json`
`git.deploymentEnabled=false`, no GitHub deployments or commit statuses on the repository. Both operations were then
refused by Claude's permission layer and were **not** attempted any other way:
- `git push origin d78cd50…:refs/heads/main`: refused twice by the auto-mode classifier, then **succeeded on the owner's retry instruction** (see Progress).
- `vercel deploy`: hard deny `Bash(vercel deploy:*)` in `.claude/settings.json` (deny beats allow).
Narrowest settings change that unblocks exactly these two operations (owner edits; the agent does not change its own permissions):
1. `.claude/settings.json` deny: replace `Bash(vercel deploy:*)` with `Bash(vercel deploy --prod:*)` (production stays denied).
2. `.claude/settings.local.json` allow: `Bash(git push origin d78cd5062b9ad2d7787c24f48120f9183e336c6c:refs/heads/main)` and
   `Bash(vercel deploy --scope devarchith-s-projects --yes)`.
Force pushes, `prisma db push`, production migrations and production deploys remain denied.

## Runbook (remaining steps)
1. Vercel: new project `velora-valley-store` (framework Next.js, region `sin1`, Node 24, build `npm run vercel-build`,
   which never writes to the database), production branch = `backend/development` (not `main`), Preview deployments
   protected (Vercel Authentication).
2. Marketplace → Neon: database `velora-staging` connected to Preview, `velora-production` connected to Production.
   Set `PRODUCTION_DB_HOSTS` (production host) in both scopes so a preview on the production host fails its build.
3. Env (per scope): `SESSION_SECRET` (48+ random chars), `CRON_SECRET` (32+), `PAYMENT_MODE=request_only` (Production)
   / `razorpay_test` (Preview, test keys only), `ADMIN_LEGACY_LOGIN=off`, no `ADMIN_PASSWORD`, `NOTIFY_MODE` and
   `CUSTOMER_OTP_MODE` unset until the email provider exists. Never `RAZORPAY_LIVE_ENABLED`.
4. Migrations from a trusted machine: `npm run db:migrate:deploy` (staging) and `db:migrate:deploy:production` with
   `APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host>`; `db:schema:diff` = no difference; seed the catalogue once with
   `npm run db:seed` (explicit, reviewed; never in a build); `npm run admin:bootstrap` for the first owner.
5. Staging acceptance: smoke (`npm run test:api` with `TEST_ALLOWED_HOSTS` = the preview host), browser journeys,
   Razorpay test-mode run (`RELEASE.md` E1), `npm run db:restore-drill` against a Neon branch.
6. Production: deploy, verify `/api/health`, pages, owner sign-in, one pay-on-delivery order placed and cancelled,
   `ops:readiness`. Rollback: Vercel Instant Rollback to the previous deployment; database: Neon branch/PITR taken
   before migrating (`RUNBOOK-DATABASE.md`).

## Business handover
Day-to-day operation is in `docs/HANDOVER.md` (roles, morning checks, orders, refunds, stock, GST, wholesale). M12
changes staff will notice: an admin account change with a weak new password now changes nothing at all; GST, shipping,
price-list, price, MOQ and wholesale-terms edits fail visibly (and change nothing) if they cannot be recorded in the
activity log; invoices show names typed in Telugu/Hindi/Tamil etc. in Latin letters; a wholesale buyer whose account is
suspended mid-checkout is refused.
