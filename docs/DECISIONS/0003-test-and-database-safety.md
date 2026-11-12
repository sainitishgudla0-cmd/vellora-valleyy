# ADR 0003 — Fail-closed safety for tests and database scripts

- **Status:** accepted (M1, 2026-11-11). Implemented in `src/lib/env/test-safety.ts`, `scripts/lib/safety.ts`, `scripts/db-guard.ts`, `src/app/api/internal/test-environment/route.ts`.
- **Context:** The smoke test (orders, enquiries, a temporary price edit), the UI test (a real order) and the cleanup script (deletes) could be pointed at production. The README even suggested `BASE_URL` = the live site.
- **Decision:** Writes require positive proof of a disposable target:
  1. `TEST_TARGET=disposable` is declared.
  2. The DB host is loopback or in `DISPOSABLE_DB_HOSTS`, not in `PRODUCTION_DB_HOSTS`, and `APP_ENV` resolves to development or test. Credentials are never echoed.
  3. HTTP tests: the URL is loopback or in `TEST_ALLOWED_HOSTS`. Built-in production hosts (`velora-valley.vercel.app`, `veloravalley.com`, `www.veloravalley.com`) and `PRODUCTION_HOSTS` are always refused. **And** the server itself confirms through `/api/internal/test-environment`, because the client can't see which DB a server uses. Production and preview always answer 404, so old deployments and unknown servers fail closed.
  4. Production writes (catalogue sync, migrations) are a separate, explicit path: `APP_ENV=production` + `CONFIRM_PRODUCTION_DB_HOST` matching the URL host.
- **Consequences:** Running tests needs a throwaway Postgres (documented in `docs/TESTING.md`; CI uses a service container). Remote QA environments must be explicitly allow-listed. The admin "Remove test data" button stays as the way to clean legacy test records in production.
