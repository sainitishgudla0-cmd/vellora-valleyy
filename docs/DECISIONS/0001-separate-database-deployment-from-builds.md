# ADR 0001 — Separate database deployment from application builds

- **Status:** accepted (M1, 2026-11-11)
- **Context:** `vercel-build` ran `prisma db push --skip-generate && tsx prisma/seed.ts` on every deploy. Every build, including any preview that shares the production `DATABASE_URL`, could change the production schema and catalogue. There was no migration history (`db push` only), so schema changes couldn't be reviewed, rehearsed or rolled back.
- **Decision:**
  - `vercel-build` = `env:check` → `prisma generate` → `next build`. Builds only read the database (catalogue prerender).
  - Schema changes go through Prisma Migrate (`prisma/migrations`, baseline `0_init` generated offline). Production migrations and catalogue syncs are explicit operator steps with a host confirmation (`docs/RUNBOOK-DATABASE.md`).
  - `db:push` was removed from the npm scripts.
- **Consequences:** Adding products to production now needs an explicit `db:seed` with confirmation instead of a redeploy. Production must be baselined (`migrate resolve --applied 0_init`) before its first migration. Builds still need a reachable database for prerendering (a later option: make the layout tolerate a missing DB at build time).
