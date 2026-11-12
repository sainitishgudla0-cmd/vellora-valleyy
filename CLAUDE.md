# Velora Valley — engineering instructions

India-focused D2C + wholesale e-commerce for Anantha Food Products. Next.js 16 App Router · React 19 · TypeScript strict · Prisma 5.22 / Postgres (Neon) · Zod 4 · Vitest · Vercel (`sin1`).

## Start here
- Current state and next task: `docs/PROGRESS.md` (read first, keep it compact).
- Run `/next` to execute the next approved task, `/verify` to run gates, `/review` before committing.
- Canonical docs (don't duplicate them): `docs/ARCHITECTURE.md` · `docs/API-CONTRACTS.md` · `docs/BACKEND-ROADMAP.md` · `docs/TESTING.md` · `docs/RUNBOOK-DATABASE.md` · `docs/DECISIONS/`.
- Area rules load from `.claude/rules/` when you touch matching files.

## Workflow (direct integration, no PRs)
1. Work and commit on `backend/<milestone>` (from `backend/development`). Push the branch freely; CI runs on `backend/**`.
2. When the task's gates pass (`npm run verify`; `verify:full` at milestone gates), CI is green on the pushed branch, and the tree is clean: `git fetch`, `git switch backend/development`, `git merge --ff-only origin/backend/<milestone>`, `git push origin backend/development`. If a fast-forward is impossible, rebase the milestone branch onto `backend/development` locally, re-verify, then retry; never force-push or create merge commits.
3. Confirm the remote SHA and the CI run on `backend/development`. `main` is promoted only by the user.

## Commands
| Purpose | Command |
|---|---|
| Fast gate (no DB) | `npm run verify` (typecheck + unit tests + env gate) |
| Focused tests | `npx vitest run tests/unit/<file>` |
| Milestone gate (disposable DB) | `TEST_TARGET=disposable APP_ENV=test DATABASE_URL=… npm run verify:full` |
| New migration | `npm run db:migrate:dev -- --name <change>` (guarded) |
| Dev server | `npm run dev` |

## Hard safety rules
1. Never commit to or merge into `main`. Work on `backend/<milestone>` branches and integrate by direct fast-forward into `backend/development` (see Workflow). **Never open a pull request** (no `gh pr create`, no create-pr command) unless the user explicitly asks for one in that message.
2. Never point any command at the production database or site. DB-changing scripts are guarded (`scripts/db-guard.ts`); never bypass, weaken or "temporarily" disable a guard.
3. Never run `prisma db push`, `prisma migrate reset`, or ad-hoc SQL against shared databases. Schema changes go through `prisma/migrations` only.
4. Never deploy (`vercel deploy`, `vercel --prod`) or change Vercel/GitHub settings unless the user explicitly asks in this session.
5. Never enable live payments or put real keys/secrets in code, tests, docs or logs. `PAYMENT_MODE` rules: `src/lib/env/payment-config.ts`.
6. Do not change the customer-facing frontend (`src/app/**/page.tsx`, `src/components/**`, `src/styles`, `public/`) unless the task says so.
7. A failed or skipped check is reported as failed/unverified. Never mark work complete without evidence.

## Token discipline
- Don't read `public/images/**`, `package-lock.json`, `.next/`, or whole large files; grep and read line ranges.
- Reuse `docs/API-CONTRACTS.md` instead of re-reading route files; update it when a contract changes.
- One coherent task per `/next` run; record decisions in `docs/DECISIONS/`, state in `docs/PROGRESS.md`.
