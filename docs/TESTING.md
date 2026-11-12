# Testing

| Layer | Location | Needs | Command |
|---|---|---|---|
| Unit | `tests/unit/*.test.ts` | nothing (DB and network mocked) | `npm run test` · focused: `npx vitest run tests/unit/<file>` |
| Integration | `tests/integration/*.test.ts` | migrated **disposable** Postgres | `npm run test:integration` |
| API smoke | `scripts/smoke-test.ts` (41 checks) | running server on a disposable DB | `npm run test:api` |
| Browser UI | `scripts/e2e-ui.mjs` (51 checks) | same + Chrome (`CHROME_PATH`) | `npm run test:ui -- <base-url>` |
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

## Conventions
- Regression test for every fix (it must fail without the fix). Contract tests for every route.
- Test data uses `SMOKE TEST` / `smoke.` markers and fake credentials (`rzp_test_*`, locally computed HMACs).
- Lint: not configured yet (Next 16 removed `next lint`); strict `tsc` is the gate until M9 (ADR 0004).
