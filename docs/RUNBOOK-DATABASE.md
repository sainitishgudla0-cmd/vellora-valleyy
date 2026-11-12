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
- Each migration's commit message and PROGRESS entry state its rollback (down SQL or restore point) in the description.

## Production catalogue sync (replaces the old deploy-time seed)
After reviewing `src/data/products.ts` changes:
`APP_ENV=production CONFIRM_PRODUCTION_DB_HOST=<host> DATABASE_URL=<prod pooled> DATABASE_URL_UNPOOLED=<prod direct> npm run db:seed`
This upserts products and variants and keeps admin-edited prices. Never pass `--reset-prices` in production without sign-off.

## M2-T1 enum migration `20261112021101_order_payment_enums` (operator notes)
Converts `Order.status` / `paymentMethod` / `paymentStatus` from TEXT to Postgres enums (ADR 0005). It locks `"Order"`, pre-checks every value, and aborts with the offending values and row counts if any row is outside the supported set (nothing is rewritten). One implicit transaction.
- **Before production:** Neon backup branch, then rehearse on it (`migrate deploy` there). If the pre-check aborts, inspect the listed rows; fix them with a reviewed one-off statement, never by loosening the migration.
- **Deploy order (breaking window):** run the migration, then deploy the app that has the regenerated Prisma client. The previous app build (string-typed client) cannot write the enum columns, so keep the window short and pause order intake meanwhile. Migrations are operator-run (`db:migrate:deploy:production`); builds never migrate.
- **Rollback** (only if no new enum values were written; values stay identical strings):
  ```sql
  ALTER TABLE "Order" ALTER COLUMN "paymentStatus" DROP DEFAULT;
  ALTER TABLE "Order" ALTER COLUMN "status" TYPE TEXT USING "status"::text,
    ALTER COLUMN "paymentMethod" TYPE TEXT USING "paymentMethod"::text,
    ALTER COLUMN "paymentStatus" TYPE TEXT USING "paymentStatus"::text;
  ALTER TABLE "Order" ALTER COLUMN "paymentStatus" SET DEFAULT 'unpaid';
  DROP TYPE "OrderStatus"; DROP TYPE "PaymentStatus"; DROP TYPE "PaymentMethod";
  DELETE FROM "_prisma_migrations" WHERE migration_name = '20261112021101_order_payment_enums';
  ```
  then redeploy the previous app build. Or restore the Neon backup branch.

## M2-T3..T5 migrations (`payment_attempts`, `order_payment_mode`, `payment_reconciliation`) — operator notes
All additive. `order_payment_mode` adds CHECK constraints (mode/method pairing; mock orders hold no Razorpay ids; Payment provider/mode pairing; mock payment ids `mock_pay_*`); existing orders keep `paymentMode = NULL` (unclassified). Rollback = drop the added constraints/columns/tables in reverse order after a Neon backup branch.
- **Deploy order for T5 (important):** migrations first, then the app. Orders placed *before* the app deploy have no `Payment` attempt and no `paymentMode`; if their customer pays during the window, `/verify` answers `409` (legacy_unclassified) and the payment must be reconciled by hand (check the Razorpay dashboard, then use the admin tools / a reviewed one-off). Keep the window short or pause online checkout.
- Run `npm run payments:reconcile` periodically (until M10 webhooks) and after any Razorpay incident.

## M2-T6 migration `manual_payment_confirmation` (operator notes)
Additive: `Payment.manualReference` (unique, request-only only via CHECK) and `OrderEvent.paymentReference`. Rollback: drop `Payment_manual_reference_request_only_check`, `Payment_manualReference_key` and the two columns.
- Legacy orders (mode NULL) and orders without a `Payment` row cannot be edited through the admin API. Reconcile such a payment by hand: check the Razorpay/cash records, then apply one reviewed statement per order that sets the payment status and inserts a matching `OrderEvent` (actorType `admin`, a reason naming the evidence) in one transaction. Never edit rows without an event.
