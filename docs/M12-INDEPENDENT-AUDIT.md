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
| `main` promotion | **not done — unsafe** | "Launch blockers" 2 |
| Vercel staging / production | **blocked** | "Launch blockers" 1 |

## Deployment decision (2026-11-22)
**Staging and production were deliberately not deployed.** Deploying this commercial store on the Hobby account would
breach Vercel's terms, and the deployment would be rejected anyway unless the payment-expiry, reconciliation and email
crons were cut to once a day (which would leave customers' stock held and payments unreconciled for up to a day). Paying
for a plan or starting a trial is the owner's decision. Everything that does not need Vercel was completed and verified
above. No Vercel project, database or environment variable was created or changed; `velora-valley-v3` and Nitish's
infrastructure were not touched; `main` is unchanged (`55aa848`); live payments remain disabled (no live keys anywhere).

## Launch blockers (exact; each needs the owner)
1. **Vercel plan.** The connected account (`devarchith5-1566`, scope `devarchith-s-projects`) is on **Hobby**
   (checked 2026-11-22: `billing.plan = "hobby"`, no teams). Vercel's Terms §4: *"You shall only use the Services under
   a Hobby plan for your personal or non-commercial use"* — an online store for Anantha Food Products is commercial.
   Independently, Hobby cron jobs may run at most once a day and a more frequent expression **fails the deployment**
   ("Hobby accounts are limited to daily cron jobs"); `vercel.json` needs `*/15` (payment-window expiry, releases held
   stock), `7,22,37,52` (payment reconciliation) and `*/10` (email outbox). Making these daily would leave stock held
   for up to a day and payments unreconciled for hours, so they were not weakened. **Resolution:** the owner upgrades
   the account (or creates a Pro team) in the Vercel dashboard (Settings → Billing; Pro is a paid plan; a 14-day Pro
   trial is offered on this account). Starting a trial or paying is the owner's decision and was not done by the agent.
   The Vercel MCP connection also needs team access (`authorize_team_access`); the Vercel CLI is already signed in to
   this account.
2. **`main` promotion is unsafe.** The Vercel and Render GitHub apps receive every push to this repository, the
   original production project (`velora-valley.vercel.app`, owned by Nitish) is not visible from this account, and its
   Git connection and production branch are unknown (M11 `RELEASE.md` A0 questions 1-5 are still unanswered). Pushing
   this code to `main` could build that project against its production database, which has none of the backend
   migrations (M11 F22: no compatible overlap), i.e. a broken live site. `main` stays at `55aa848`. Not needed for a NEW
   project: it can deploy `backend/development` (or a release branch) as its production branch, or via the CLI.
   The account's existing project `velora-valley-v3` is linked to a different repository (`devarchith/velora-valley-v3`)
   and has no environment variables; it was left untouched.
3. **Database.** A new Neon Postgres (Vercel Marketplace) per environment: staging and production on separate
   projects or branches; production on a plan with point-in-time restore. Creating it accepts the provider's terms and
   picks a (possibly paid) plan; it waits on blocker 1 (the database is attached to the new Vercel project).
4. **Business inputs that must not be invented** (unchanged from M11): email provider + verified sender domain
   (`SMTP_URL`, `EMAIL_FROM`; without them customer sign-in and order emails stay off), accountant-approved GST rates
   per HSN and `SELLER_GSTIN`, opening stock counts, shipping rules (serviceable pincodes, fees), offline-payment policy
   (ADR 0024), the owner's admin email (the owner chooses the password at `admin:bootstrap`), Razorpay **test** keys and
   test webhook secret for the staging payment run.

## Owner runbook once blocker 1 is resolved (agent-executable after the owner's go-ahead)
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
