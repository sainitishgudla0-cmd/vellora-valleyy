# M11 release-candidate report — 2026-11-20

**Release candidate:** `backend/development` @ `b2862da` + this docs commit (code final at `95e1323`; `b2862da` is the parallel session's P1-T3 evidence docs). It contains this stack (16 commits, built on worktree branch `m11b/work`, pushed as `backend/m11-security-ops`, code final at `33d0b62`) and P1-T3 from the parallel session.
**Integrated (2026-11-20, owner chose this stack first):** `backend/m11-stabilization` fast-forwarded `eb6be73..64d5b26` (CI run 44789949597 green, all three jobs: https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44789949597), then `backend/development` fast-forwarded `e17a1ba..64d5b26` (CI run 44791463928 green, all three jobs: https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44791463928). P1-T3 (F06) from the parallel session was rebased on top as `95e1323` (CI run 44791548874 green: https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44791548874) and fast-forwarded into `backend/development` (CI run 44793165095 green, all three jobs: https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44793165095).
**Production readiness:** not established. CI and the local gates are green, but the operator/business items in "Remaining blockers" must be done before real customers use this code.

## Commits
| SHA | Change |
|---|---|
| `b80e6dd` | P1-T4 critical audit rows fail closed (F07, ADR 0021) |
| `a17e216` | P1-T6 fail-closed rate limits for sensitive routes (F08, ADR 0022 §1) |
| `e88cc1b` | P1-T5 shared admin password read-only, off in production; atomic owner recovery (F05, ADR 0022 §2) |
| `f5c0b0c` | next 16.4.2 → 16.4.5 (F21, seven advisories) |
| `dd40e8b` | P2 baselining rehearsal, compatibility matrix (F22), build-never-writes test; P3-T5 crons + `CRON_SECRET` gate |
| `e010159` | P3-T3 stock initialisation from a count sheet (F11); RELEASE A7/A8/B0 |
| `2402043` | CI env-gate cases for the new gates |
| `58e3504` | P3-T1 SMTP delivery for notifications and sign-in codes (F09/F10, ADR 0023) |
| `6e97269` | Readiness report + payment exceptions (P3-T2/T4/T6) |
| `6b0a526` | P4 admin order page, operations and settings screens |
| `6971027` | P5-T3 Linux visual regression vs approved commit (F15); P3-T6 GST sign-off sheet |
| `138ebd7` | Docs: architecture (N01), staff handover, tracker |
| `a582bdb` | P1-T2 offline payment records: `payments:record`, attestation, immutable record (F04, ADR 0024; migration `20261120083137_offline_payment_record`) |
| `2226326` | P5 accessibility baseline, performance/contention check, admin view permissions |
| `33d0b62` | P4 wholesale admin tab (accounts, quote requests); CI run 44731600980 green |
| `95e1323` | P1-T3 failed online payments expire and release stock; late captures recorded as orphans (F06, ADR 0020; parallel session) |
| `main` line: `ab07872`, `4d2a80a` on `backend/m11-main-build-fix` | DB-free `vercel-build` (F01) + next 16.4.5, for the owner to promote |

## Evidence
- **CI** (GitHub Actions, `backend/m11-security-ops`): run 44731600980 @ `33d0b62` all three jobs green (https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44731600980); run 44704595020 @ `2226326` — checks, `visual` (Linux, 22 screenshots vs approved commit), and migrate/integration/build/smoke + browser: all success. Earlier runs 44698567907 @ `2402043`, 44701883163 @ `138ebd7` green; 44698293036 @ `e010159` failed (env-gate case needed `CRON_SECRET`), fixed in `2402043`. https://github.com/sainitishgudla0-cmd/vellora-valleyy/actions/runs/44704595020
- **P1-T3 on `95e1323`** (parallel session, Node 20, fresh disposable DB): `verify:full` + `VERIFY_UI=1` all green — unit 660/660, integration 634/634, smoke 70/0, Playwright 59/59.
- **`verify:full` + `VERIFY_UI=1` on the final code of this stack** (`96867a2` = `33d0b62` + docs), fresh disposable DB: every gate green — unit 660/660, integration 620/620, smoke 70/0, Playwright 59/59 (22 visual identical).
- **`verify:full` + `VERIFY_UI=1`**, fresh disposable Postgres 16.13, Node 24.22.3, @ `2226326`: typecheck ok · unit 660/660 · env ok · migrate deploy (15 incl. `0_init`) · schema drift none · seed · integration 620/620 · build · smoke 70/0 · Playwright 58/58 (22 visual identical to the macOS baselines, accessibility 3/3, admin operations 5/5). An earlier run under host load had 2 browser timeouts (90 s) that passed on rerun; recorded in the tracker.
- **Rehearsals:** `db:baseline-rehearsal` 21/21 with 14 migrations; `db:restore-drill` passed (36 tables, checksums equal, 15 migrations, no drift); `test:visual-ref` 22 captured / 22 identical; `test:perf` no oversell (40 concurrent checkouts for 5 units → 5 placed, 35 × 409, 0 errors); `main`-fix branch builds against a read-only DB role.
- **Regression tests failed on the pre-fix code:** P1-T4 7/9, P1-T6 3/4, P1-T2 5/8, P1-T3 (F06) 11/14.
- **Security review** of the branch diff: no findings at confidence ≥ 8; the one consistency gap noted was fixed in `2226326`.
- `npm audit`: 0 on the backend line; `main` line has build-time `postcss`/`tsx`/`esbuild` advisories (fixed on the backend line since M9).

## Integration
Done: `backend/m11-stabilization` = `backend/development` = `b2862da` + this docs commit (CI on `b2862da`: 44794668439 milestone branch green) (fast-forward only, no merge commits, no force-push, `main` untouched at `55aa848`). `tests/e2e/visual-baseline.ref` is unchanged because no storefront page changed.

## Remaining blockers (exact resolution)
| Blocker | Owner | Resolution |
|---|---|---|
| Production Vercel project access | owner | Grant the deploying account access to the `velora-valley` project (tracker §6) |
| `main` deploys run `db push` (F01) | owner | Promote `backend/m11-main-build-fix` to `main` **before** anything else deploys |
| Production baselining + migrations, Neon-clone rehearsal | operator | `RUNBOOK-DATABASE.md` steps 1-6; `RELEASE.md` A1, B0 (planned ordering outage; no compatible overlap with `main`, F22) |
| First owner account | operator | `npm run admin:bootstrap` against production (A1) before promotion |
| `CRON_SECRET`, `PRODUCTION_DB_HOSTS`, plan allows sub-daily crons | operator | `RELEASE.md` A2, A7 |
| Email provider (notifications + sign-in) | business, then operator | Choose provider and verified sender domain; set `NOTIFY_MODE=smtp`, `CUSTOMER_OTP_MODE=email`, `SMTP_URL`, `EMAIL_FROM` (ADR 0023) |
| Stock counts | business | Count sheet → `inventory:import` (A8) |
| Shipping rules | business | Serviceable pincodes and fees → Admin → Settings |
| GST rates, `SELLER_GSTIN`, IRN, credit notes | accountant | `tax:signoff-sheet` → Settings → GST rates (A9) |
| Who may record offline payments; partial collections; offline refunds of online payments | business | ADR 0024 (owner-only meanwhile; gateway offline refunds disabled) |
| Razorpay test-mode run, live launch | operator | `RELEASE.md` E1-E4 (F20) |
| Preview isolation, branch protection, monitoring, restore drill on Neon, RPO/RTO | operator | `RELEASE.md` A3-A5 (F16, F17, F19) |
| `/account` link in the storefront | owner (design) | Approve the change; then update the visual baseline ref |

## Remaining risks
- The first cutover is a short ordering outage and rolling back to `main` needs the pre-cutover database (F22).
- Refund, webhook and reconciliation behaviour is proven only against the fake gateway until the test-mode run (F20).
- Rate-limit keys use the first `X-Forwarded-For` hop: correct behind Vercel's proxy, spoofable if the app is ever served without it.
- Wholesale price lists, quantity tiers and MOQ have no admin screens (API only); accounts and quotes do.
- Accessibility: colour contrast and keyboard order were not machine-checked.
