# Testing

| Layer | Location | Needs | Command |
|---|---|---|---|
| Unit | `tests/unit/*.test.ts` | nothing (DB and network mocked) | `npm run test` · focused: `npx vitest run tests/unit/<file>` |
| Integration | `tests/integration/*.test.ts` | migrated **disposable** Postgres | `npm run test:integration` |
| API smoke | `scripts/smoke-test.ts` (41 checks) | running server on a disposable DB | `npm run test:api` |
| Browser E2E | `tests/e2e/*.spec.ts` (Playwright test runner) | same + Chrome (`CHROME_PATH`) | `npm run test:e2e` (server on `E2E_BASE_URL`, default 127.0.0.1:3100) |
| Fast gate | — | — | `npm run verify` (typecheck + unit + env gate) |
| Milestone gate | `scripts/verify-full.ts` | disposable Postgres | `npm run verify:full` (`VERIFY_UI=1` adds the browser test) |
| CI | `.github/workflows/ci.yml` | Postgres 16 service container | on push to `main` and `backend/**` (and on PRs, if the user opens one) |

## Safety model (ADR 0003)
Write-capable tests and DB scripts refuse to run unless **all** of these hold:
1. `TEST_TARGET=disposable`
2. the database host is loopback or listed in `DISPOSABLE_DB_HOSTS` (and not in `PRODUCTION_DB_HOSTS`), and `APP_ENV` resolves to development/test;
3. for HTTP tests: the base URL is loopback or in `TEST_ALLOWED_HOSTS` (production hosts are always refused), **and** the server's `/api/internal/test-environment` answers `testWritesAllowed: true`. Production and preview deployments always answer 404.

## Throwaway local Postgres (macOS / Homebrew `postgresql@16`)
```bash
export LC_ALL=en_US.UTF-8 PGDATA_DIR="$HOME/.velora-pg"
initdb -D "$PGDATA_DIR" -U velora --auth=trust -E UTF8
pg_ctl -D "$PGDATA_DIR" -o "-p 54329 -k '' -c listen_addresses=127.0.0.1" -l "$PGDATA_DIR/log" start
createdb -h 127.0.0.1 -p 54329 -U velora velora_test
```
Alternative: `docker run --rm -d -p 54329:5432 -e POSTGRES_USER=velora -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=velora_test postgres:16`.

Then:
```bash
export DATABASE_URL=postgresql://velora@127.0.0.1:54329/velora_test DATABASE_URL_UNPOOLED=$DATABASE_URL \
       APP_ENV=test TEST_TARGET=disposable ADMIN_PASSWORD=local-test-admin SESSION_SECRET=local-test-session-secret-0123456789
npm run verify:full
```
Stop it with `pg_ctl -D "$PGDATA_DIR" stop`, and delete the folder to reset.

## Mock payments (M2-T4)
Mock orders and attempts exist only in test fixtures (`tests/support/mock-orders.ts`); integration tests call the real `POST /api/payments/mock/confirm` handler with `PAYMENT_MODE=mock`, `APP_ENV=test` and a fake `MOCK_PAYMENT_CONFIRM_KEY` stubbed in-process. Failure injection uses temporary Postgres triggers on the disposable database. Nothing in CI or `verify:full` needs the key; the running smoke/UI server stays `request_only`.

## Payment flows (M2-T5)
Integration tests drive the real route handlers (`POST /api/orders`, `/verify`, `/mock/confirm`) against the disposable DB with `tests/support/fake-razorpay.ts` replacing `fetch`: any non-`api.razorpay.com` request throws, so tests cannot reach live services. Failure injection uses temporary Postgres triggers. `npm run payments:mock-checkout` is the dev runner for the mock flow against a running local server (`PAYMENT_MODE=mock`, `MOCK_PAYMENT_CONFIRM_KEY` set on the server and the runner, `BASE_URL`, `TEST_TARGET=disposable`); it refuses servers that do not prove they are disposable.
CI and `verify:full` run on Node 24 (use `nvm use 24`); the UI script works on both Node 20 and 24.

## Inventory and idempotency (M3)
`tests/support/inventory.ts` creates throwaway products/variants (slug prefix `m3-fixture-`, customer `SMOKE TEST Stock`) and sets stock through the real ledger, so the seeded catalogue is never touched; every inventory test file ends by asserting `findLedgerDrift()` is empty. Concurrency tests (N parallel orders for the last unit, repeated 20 times; opposite line orders for deadlocks) run against the real Postgres. Order-number collisions are forced by spying on `crypto.randomBytes`. Expiry tests use `fake-razorpay.ts`. `tests/unit/inventory-ratchet.test.ts` fails if any code outside `src/lib/inventory/` writes the stock columns.

## Admin auth (M4)
`tests/support/admin.ts` creates real accounts and real sessions (no auth mocks), so route tests exercise the production path; `cleanupAdminFixtures` also clears `AuditLog` (disposable DB only). `admin-users.test.ts` has the role × route matrix and runs `scripts/admin-bootstrap.ts` as a child process against the disposable DB (password via env, asserted never printed). `tests/unit/admin-routes-ratchet.test.ts` statically requires `requireAdmin(req, "<perm>")` in every admin handler, `writeAudit(` in every non-GET handler, and no use of the old `isAdmin` in API routes. The API smoke test keeps using the shared `ADMIN_PASSWORD` transition login. The browser test (`VERIFY_UI=1`) also drives the admin UI (owner sign-in, Account and Team tabs, creating/disabling a viewer, password change, sign-out, the empty-email shared-password sign-in): `verify:full` first creates a throwaway owner with `npm run admin:bootstrap -- --additional-owner` (allowed only on a database declared disposable) and passes it to the script as `UI_TEST_ADMIN_EMAIL` / `UI_TEST_ADMIN_PASSWORD`; `npm run db:cleanup-tests` removes `smoke.*` admin accounts. The 401/403/422 console lines in the browser-error summary are the test's deliberate requests.

## Customer accounts (M5)
`tests/support/customer.ts` signs customers in through the real OTP service with the mock sender (`CUSTOMER_OTP_MODE=mock`, `APP_ENV=test` stubbed in-process; the in-process outbox holds the codes). Fixture addresses use `@m5-fixture.example.com`. `customer-otp.test.ts` covers brute-force caps (sequential and parallel), cooldown/hourly limits, enumeration safety, hashed storage, sessions; `customer-account.test.ts` has the authz matrix, IDOR tests (addresses, orders, claims), order linking, export and erasure. `tests/unit/account-core.test.ts` ratchets that every `/api/account` handler calls `requireCustomer`. The API smoke test only checks the unauthenticated behaviour (it cannot read codes from another process).

## Wholesale (M6)
`tests/support/wholesale.ts` creates real buyers (customer + approved account), price lists and generated valid GSTINs (`makeGstin`; the checksum implementation is pinned to a published sample in `tests/unit/wholesale-core.test.ts`). Suites: `wholesale-access` (application, authz matrix across every status, **price-leakage tests**: retail endpoints byte-identical for a buyer and an anonymous visitor, own-list-only, IDOR on quotes), `wholesale-orders` (the price-resolution matrix, MOQ/case packs, bulk quantities, credit limits incl. parallel orders, idempotency), `wholesale-quotes` (lifecycle, quote -> order totals match, expiry incl. a trigger-injected expiry between check and claim, parallel accepts, stock/credit refusals leave the quote open), `wholesale-admin` (role x route matrix, approval graph, enquiry conversion, price-list and tier rules, MOQ, erasure interplay). Unit ratchets: every `/api/business` handler uses `requireCustomer`/`requireBusiness`, and retail routes never import wholesale code.

## GST, invoices, shipping, notifications (M7)
`tests/unit/gst-core.test.ts` holds the tax fixtures (illustrative 5/12/18% rates, paise-exact, intra vs inter, half-paisa rounding, a 20,000-case invariant sweep: parts always sum to the amount, tax within half a paisa of the exact value) for the accountant's review; `invoice-render.test.ts` proves PDF determinism and structure (xref offsets, stream lengths, hostile text) and template escaping. Integration: `gst-orders` (snapshot, rate lookup by date/HSN, shipping fee and serviceability in `createOrder`), `invoices` (issuing, 20 parallel invoices get exactly 1..20, failure injection leaves no gap, financial-year rollover, frozen regeneration, customer download authz, cancellation guard), `fulfilment-admin` (role x route matrix, tax-rate/shipping-rule/shipment/outbox APIs, public shipping quote), `notifications` (transactional queueing incl. rollback, retries with backoff, dead letters, parallel dispatchers send each message once, crash recovery, no network, never in production/preview). `tests/support/fulfilment.ts` stubs `SELLER_GSTIN` and `NOTIFY_MODE=mock`; the mock mailbox is in-process, so nothing reaches a real recipient.

## Browser end-to-end and visual regression (M8)
`tests/e2e/*.spec.ts` run on the Playwright test runner against a live server (`E2E_BASE_URL`, default 127.0.0.1:3100); `npm run verify:full` with `VERIFY_UI=1` builds, starts the server with the mock sign-in sender and a fake seller GSTIN, creates a throwaway owner (`admin:bootstrap --additional-owner`), and runs them; CI does the same with the runner's Chrome. Journeys: guest checkout through tracking and invoice (`guest-journey`), signed-in shopper (`account`), wholesale buyer (`wholesale`), admin (`admin`), layout (`responsive`). Tests are serial per file and share one disposable database; test data uses `smoke.` emails and `SMOKE TEST` names and `npm run db:cleanup-tests` removes it. The admin login is rate limited (8 per 15 minutes per IP): specs share one cached owner session and the admin spec uses a temporary owner. **Visual regression:** `visual.spec.ts` compares 11 existing pages (desktop and mobile) with baselines captured BEFORE a frontend change. Baselines are large and local (`tests/e2e/__screenshots__/<platform>/`, gitignored). Capture from a clean checkout: `npx playwright test visual --update-snapshots`; compare: `npx playwright test visual` (it skips where no baseline exists). `tests/unit/api-contract-coverage.test.ts` keeps `docs/API-CONTRACTS.md` and the route files in step.

## Conventions
- Regression test for every fix (it must fail without the fix). Contract tests for every route.
- Test data uses `SMOKE TEST` / `smoke.` markers and fake credentials (`rzp_test_*`, locally computed HMACs).
- Lint: not configured yet (Next 16 removed `next lint`); strict `tsc` is the gate until M9 (ADR 0004).
