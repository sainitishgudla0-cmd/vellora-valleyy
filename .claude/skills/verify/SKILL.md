---
name: verify
description: Run the appropriate Velora Valley quality gates (typecheck, unit, integration, build, API smoke) against safe targets and check the current task's acceptance criteria with evidence. Use before claiming any change works.
---
# /verify — run gates and check acceptance criteria

Commands and environments are documented in `docs/TESTING.md`. Never point a gate at production, and never weaken a guard to make a gate pass.

1. **Always:** `npm run verify` (typecheck + unit tests + env gate). Capture the summary lines.
2. **If the change touches** `prisma/`, `src/app/api/**`, `src/lib/**` (orders, payments, db), or a milestone is closing: run `npm run verify:full` against a disposable Postgres:
   - Local: start the throwaway cluster described in `docs/TESTING.md`, then
     `TEST_TARGET=disposable APP_ENV=test DATABASE_URL=… DATABASE_URL_UNPOOLED=… ADMIN_PASSWORD=<test> SESSION_SECRET=<test 24+ chars> npm run verify:full`
   - Add `VERIFY_UI=1 CHROME_PATH=…` when UI flows changed.
   - If no disposable DB can be started, report `verify:full` as **UNVERIFIED** with the reason. Never substitute another database.
3. **Frontend preservation:** `git diff --stat backend/development -- src/app src/components src/styles src/store public` should be empty unless the task allows UI changes.
4. **Acceptance criteria:** for each criterion of the current task (from `docs/BACKEND-ROADMAP.md`), state PASS / FAIL / UNVERIFIED with the evidence: a test name, command output line or file reference.
5. Output a compact table: gate · command · result · evidence. Any FAIL or UNVERIFIED gate means the task is not complete.
