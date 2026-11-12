# ADR 0005 — Order and payment statuses are native Postgres enums

- **Status:** accepted (M2-T1, 2026-11-11)
- **Context:** `Order.status`, `paymentStatus` and `paymentMethod` were free TEXT, so a bad write (typo, case change) was stored silently and the state machine (M2-T2) would have nothing to rely on.
- **Decision:**
  - Prisma enums `OrderStatus`, `PaymentStatus`, `PaymentMethod`. Labels are **exactly the legacy strings**, so API/JSON, URLs, admin UI and tests see no change.
  - `PaymentMethod` contains only `cod` and `razorpay`. `cod` is the request-only/pay-on-delivery flow: `paymentStatus` stays `unpaid` until externally confirmed. This task adds **no** offline-payment confirmation mechanism; staff reference capture and audited manual confirmation belong to M2-T2/T6. Market-specific methods (e.g. a UPI or bank method) are added later with `ALTER TYPE ... ADD VALUE` in their own migration, keeping the model market-configurable.
  - Migration is hand-written (Prisma's generated drop/add would lose data): `LOCK TABLE` → pre-check that aborts on any unsupported value with counts (no trimming, case-folding or defaulting) → `CREATE TYPE` → in-place `ALTER COLUMN ... TYPE ... USING` casts → restore `paymentStatus` default `'unpaid'`.
  - The admin PATCH schema derives from the Prisma enums. Frontend lists (`statuses.ts`, `orderSchema`) stay literal, guarded by drift tests.
- **Consequences:** a breaking deploy window in production (old client cannot write enum columns); see `RUNBOOK-DATABASE.md`. Rehearsal tests (`tests/integration/enum-migration.test.ts`) run on scratch databases of the disposable server.
