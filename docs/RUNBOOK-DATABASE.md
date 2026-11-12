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

## M3 migration `inventory_and_idempotency` (operator notes)
- Additive: three `Variant` columns (`trackInventory` default false, `stockQuantity`/`reserved` default 0), tables `InventoryMovement` and `IdempotencyKey`, enum `InventoryReason`, index `Order(status, createdAt)`, and CHECK constraints (not shown by `migrate diff`). Existing variants keep the manual `inStock` flag, so deploying changes no behaviour. Deploy the migration **before** the app that reads the new columns.
- **Rollback:** drop the two CHECKs, the two tables, the enum, the index and the three columns (only before tracking is used; afterwards the ledger is the record of stock).
- **Enabling tracking for a variant** (admin API): `PATCH /api/admin/variants/<id>` with `{"trackInventory":true,"reason":"Start counting","stockAdjust":{"delta":<opening count>,"reason":"Opening stock count"}}`. Count physical stock first; units already promised to open pay-on-delivery orders placed before tracking are **not** reserved, so add them to the count only after those orders ship.
- **Expiry job:** set `CRON_SECRET` (24+ random characters) in the deployment environment, then add a cron to `vercel.json` once the plan allows the schedule, e.g. `"crons":[{"path":"/api/internal/orders/expire","schedule":"*/15 * * * *"}]` (Hobby plans accept daily schedules only; an unsupported schedule fails the deploy). Until then expiry can be run by calling the route with the bearer token. `PAYMENT_WINDOW_MINUTES` is optional (default 60).
- **Health check:** SUM of `InventoryMovement.stockDelta`/`reservedDelta` per variant must equal `Variant.stockQuantity`/`reserved` (`findLedgerDrift` in `src/lib/inventory/ledger.ts`). A mismatch means something wrote the counters outside the ledger.
- Orders cancelled after dispatch do **not** restock; adjust by hand when goods come back.

## M4 migration `admin_auth` and first owner (operator notes)
- Additive: tables `AdminUser`, `AdminSession`, `AuditLog`, enum `AdminRole`, two CHECKs. Deploy the migration **before** the app that reads them. **Rollback:** drop the three tables and the enum (audit history is lost).
- Deploying the app invalidates every existing admin cookie (they were stateless); staff sign in again. The shared-password login keeps working while `ADMIN_PASSWORD` is set, so the dashboard form is not locked out during rollout.
- **Create the first owner** (once, from a trusted machine with the production `DATABASE_URL` and the explicit production confirmation the guard asks for): `npm run admin:bootstrap -- --email you@example.com --name "Your Name"` (password via the hidden prompt, or `ADMIN_BOOTSTRAP_PASSWORD` for the single command; unset it afterwards). It refuses if an owner already exists.
- **Add staff** as the owner: sign in with `POST /api/admin/login { email, password }`, then `POST /api/admin/users` (use the returned cookie). Share the initial password out of band; the person changes it with `POST /api/admin/account/password`.
- **Owner recovery** (lost password, locked out, account disabled): `npm run admin:bootstrap -- --reset --email owner@example.com`. Ends all of that owner's sessions, clears the lock, re-activates the account. Needs database access; there is no email reset.
- **Retire the shared password** (the login form now accepts an email): first make sure every person has an account (Team tab or `POST /api/admin/users`) and the owner can sign in, then set `ADMIN_LEGACY_LOGIN=off`, later remove `ADMIN_PASSWORD`. Live legacy sessions end immediately. `scripts/smoke-test.ts` and the UI test use the shared password; they must keep `ADMIN_PASSWORD` set on their own disposable server.
- `SESSION_SECRET` (24+ chars) now keys the session-token hash: changing it signs everyone out. `ADMIN_ALLOWED_ORIGINS` (comma-separated origins) is only needed if the admin is served from a host other than the one the browser addresses (a proxy that rewrites `Host`).
- Lockout: 5 wrong passwords = 15 minutes; an owner can unlock with `PATCH /api/admin/users/<id> { "unlock": true }`.

## M5 migration `customer_accounts` (operator notes)
- Additive: tables `Customer`, `CustomerSession`, `Address`, `OtpChallenge`, `ConsentRecord`; nullable `Order.customerId` (existing orders stay guest orders, FK `ON DELETE SET NULL`); index `Order(customerId, createdAt)`; a partial unique index (one default address per customer) and a CHECK on the attempt counter. Deploy the migration **before** the app. **Rollback:** drop the FK/column on `Order`, the five tables and the index (customer data is lost).
- **Customer sign-in is off in production until M7** (no real OTP sender): `POST /api/account/otp/request` answers 503. Do **not** set `CUSTOMER_OTP_MODE=mock` outside development/test; `npm run env:check` fails the build if you do. `SESSION_SECRET` also keys the customer token and code hashes: changing it signs every customer out and invalidates pending codes.
- **Privacy requests:** customers can export and delete through the API. For a request received by other means (email), an operator can run the same functions in `src/lib/account/erasure.ts`; deletion is refused while the person has open orders. Retention of order records is a business/legal decision (ADR 0013).
- Old sign-in challenges are deleted opportunistically (24 h); expired sessions are simply ignored.

## M6 migration `wholesale` (operator notes)
- Additive: tables `PriceList`, `PriceListItem`, `VariantWholesale`, `BusinessAccount`, `Quote`, `QuoteItem`, `QuoteEvent`; enums `BusinessAccountStatus`, `PaymentTerms`, `QuoteStatus`; nullable `Order.businessAccountId`; a partial unique index (one live account per GSTIN) and CHECKs on prices, quantities and quoted totals. Existing orders and all retail behaviour are unchanged. Deploy the migration **before** the app. **Rollback:** drop the FK/column on `Order`, the tables and enums (business data is lost).
- **Wholesale is dormant in production until customer sign-in works (M7).** Staff can still prepare: create price lists and MOQs, and convert business enquiries (`POST /api/admin/enquiries/[id]/convert`); an account created from an enquiry attaches to the person when they first sign in with that email.
- Setting up a buyer: create a price list, add tiers per variant (`PUT .../price-lists/<id>/items`), approve the account with terms and the list (`PATCH .../wholesale/accounts/<id>`). Closing an account cancels its open quotes. Credit limits are checked at order creation; prepaid orders must be paid before dispatch by process (no system block).
- Quote expiry runs in the same scheduled job as order expiry (`/api/internal/orders/expire`, `quotesExpired` in its counts); accepting also checks the clock, so a missed run cannot let an expired quote through.
