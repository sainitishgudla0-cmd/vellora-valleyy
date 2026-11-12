# Database runbook

Operator-only procedures. Agents must not run anything in the "production" sections (CLAUDE.md, hard rule 2).

## Commands (all `db:*` writes are guarded by `scripts/db-guard.ts`)
| Command | What | Allowed targets |
|---|---|---|
| `db:generate` | Prisma client | no DB |
| `db:migrate:dev -- --name x` | create and apply a migration | disposable only |
| `db:migrate:deploy` | apply pending migrations | disposable only |
| `db:migrate:deploy:production` | apply pending migrations | production, with `APP_ENV=production` + `CONFIRM_PRODUCTION_DB_HOST=<host>` |
| `db:migrate:status` | read-only status | any |
| `db:schema:diff` | read-only: live DB vs `schema.prisma` (exit 0 = identical, 2 = drift) | any |
| `db:baseline:sql` | offline SQL for the full schema | no DB |
| `db:seed` | catalogue upsert | disposable; production only with the same confirmation |
| `db:cleanup-tests` | delete `SMOKE TEST` rows | disposable + `TEST_TARGET=disposable` |

## Current state (M1)
- `prisma/migrations/0_init` was generated **offline** from `schema.prisma` (`prisma migrate diff --from-empty`). It applies cleanly to an empty Postgres 16 and `db:schema:diff` reports no drift (verified on a throwaway DB).
- **Production has not been baselined.** It was created with `prisma db push` and has no `_prisma_migrations` table. `prisma migrate deploy` against it fails with **P3005** (schema not empty), which is a safe failure.
- Vercel builds no longer run `db push` or the seed. Production schema and catalogue are unchanged by deploys from M1 onward.

## Production baselining (before the first production migration, M9 or earlier)
1. **Freeze:** no deploys or admin edits during the window. Announce the window.
2. **Backup:** create a Neon branch from production (instant copy-on-write) named `pre-baseline-YYYYMMDD`, and take a `pg_dump --format=custom` of the production database to secure storage. Verify the dump restores into a scratch database.
3. **Compare:** with a direct (unpooled) production URL in a one-off shell, never in `.env`:
   `prisma migrate diff --from-url "$PROD_UNPOOLED" --to-migrations prisma/migrations --shadow-database-url "$SCRATCH_URL" --script`
   The output must be empty. Any difference means production drifted from the repo: stop, write an ADR, and reconcile with an explicit migration first.
4. **Rehearse** on the Neon backup branch: `prisma migrate resolve --applied 0_init`, then `prisma migrate deploy` (should be a no-op), then run the app's read paths against it.
5. **Baseline production:** `APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host> prisma migrate resolve --applied 0_init` (records the baseline only; no DDL). Then `npm run db:migrate:status` must report up to date.
6. **Rollback:** baselining writes only the `_prisma_migrations` row. Roll back by deleting that row, or by restoring the Neon backup branch.

## Future production migrations
- Additive migrations only. Destructive steps (drop, rename, type narrowing) need an ADR and an expand → migrate → contract plan across releases.
- Order: back up (Neon branch) → `db:migrate:deploy:production` → deploy the app version that needs it → `db:schema:diff` = no drift.
- Each migration PR states its rollback (down SQL or restore point) in the description.

## Production catalogue sync (replaces the old deploy-time seed)
After reviewing `src/data/products.ts` changes:
`APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host> DATABASE_URL=<prod pooled> DATABASE_URL_UNPOOLED=<prod direct> npm run db:seed`
This upserts products and variants and keeps admin-edited prices. Never pass `--reset-prices` in production without sign-off.
