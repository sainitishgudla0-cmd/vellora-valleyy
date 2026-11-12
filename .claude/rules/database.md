---
paths:
  - "prisma/**"
  - "scripts/**"
  - "src/lib/db.ts"
---
# Database rules

- Schema changes: edit `prisma/schema.prisma`, then `npm run db:migrate:dev -- --name <change>` against a local/disposable DB, and commit the generated `prisma/migrations/<ts>_<name>/`. Never edit an applied migration.
- Forbidden on any shared database: `prisma db push`, `prisma migrate reset`, `migrate dev`, raw destructive SQL. `vercel-build` must never touch the database.
- Additive and backward-compatible first (new nullable columns/tables, backfill, then constrain). A destructive change needs an ADR plus a backup and rollback note in `docs/RUNBOOK-DATABASE.md`.
- Every script that writes calls the guards in `src/lib/env/test-safety.ts` (`assertDisposableDatabase` / `assertDatabaseWriteAllowed`) before connecting.
- Production baselining and migrations follow `docs/RUNBOOK-DATABASE.md` and are done only by the operator.
- After a schema change: `npm run db:schema:diff` on the disposable DB must report no difference after `migrate deploy`.
