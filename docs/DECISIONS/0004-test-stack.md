# ADR 0004 — Test stack: Vitest; lint deferred

- **Status:** accepted (M1, 2026-11-11)
- **Decision:** Vitest 4.1.12 (exact pin; supports the local Node 20 and CI Node 24) for unit and integration tests, with configs in `vitest*.mts` (`server-only` aliased to a stub). The existing `tsx` smoke script and `playwright-core` UI script are kept and wrapped by `scripts/verify-full.ts`. CI = GitHub Actions with a Postgres 16 service container.
- **Lint:** not added in M1. Next 16 removed `next lint`, and adding ESLint plus `eslint-config-next` is a separate change. Strict `tsc` is the static gate until M9 (task M9-T6).
- **Consequences:** `npm run verify` runs in under a minute with no DB; `verify:full` is the milestone gate.
