---
paths:
  - "tests/**"
  - "scripts/**"
  - "vitest*.mts"
  - ".github/workflows/**"
---
# Testing rules

- Commands and environments: `docs/TESTING.md`. Unit tests (`tests/unit`) have no DB or network; integration tests (`tests/integration`) use a disposable Postgres only.
- Every bug fix gets a regression test that fails without the fix. Every new route gets contract tests (status codes + body shape).
- Write-capable tests must call the safety handshake (`scripts/lib/safety.ts`) or guards; never add a write test that skips them.
- During development run focused tests (`npx vitest run <file>`); run `npm run verify` before every commit and `verify:full` at milestone gates.
- Test data uses the `SMOKE TEST` / `smoke.` markers (`src/lib/test-data.ts`) and fake credentials only.
- Never report a gate as passed unless it ran in this session; quote the summary line as evidence.
