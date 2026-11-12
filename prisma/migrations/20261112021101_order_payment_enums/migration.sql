/*
  M2-T1: convert Order.status / paymentMethod / paymentStatus from TEXT to native Postgres enums.

  Hand-written (replaces the Prisma-generated DROP COLUMN/ADD COLUMN, which would destroy data).
  Values are preserved byte-for-byte: every enum label equals the legacy string.

  Safety:
  - Runs in one implicit transaction: any failure leaves the table untouched.
  - "Order" is locked first so no row can be written between the pre-check and the conversion.
  - The pre-check aborts the migration, listing each offending value and its row count, if any row holds a
    value outside the supported set. Nothing is rewritten, trimmed, case-folded or defaulted.
  - Rollback: see docs/RUNBOOK-DATABASE.md ("Reverting 20261112021101_order_payment_enums").
*/

LOCK TABLE "Order" IN ACCESS EXCLUSIVE MODE;

-- Pre-check: fail safely on unknown legacy values.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s=%L (%s rows)', col, val, n), '; ' ORDER BY col, val) INTO bad
  FROM (
    SELECT 'status' AS col, "status" AS val, count(*) AS n FROM "Order"
      WHERE "status" NOT IN ('pending_confirmation', 'awaiting_payment', 'confirmed', 'paid', 'dispatched', 'delivered', 'cancelled')
      GROUP BY "status"
    UNION ALL
    SELECT 'paymentStatus', "paymentStatus", count(*) FROM "Order"
      WHERE "paymentStatus" NOT IN ('unpaid', 'paid', 'failed', 'refunded')
      GROUP BY "paymentStatus"
    UNION ALL
    SELECT 'paymentMethod', "paymentMethod", count(*) FROM "Order"
      WHERE "paymentMethod" NOT IN ('cod', 'razorpay')
      GROUP BY "paymentMethod"
  ) offenders;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'M2-T1 enum migration aborted: unsupported legacy values in "Order": %. No data was changed. Fix or review these rows manually, then re-run.', bad
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_confirmation', 'awaiting_payment', 'confirmed', 'paid', 'dispatched', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'paid', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cod', 'razorpay');

-- AlterTable: in-place cast, no column drop. The TEXT default must be dropped before the type changes.
ALTER TABLE "Order" ALTER COLUMN "paymentStatus" DROP DEFAULT;

ALTER TABLE "Order"
  ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::"OrderStatus"),
  ALTER COLUMN "paymentMethod" TYPE "PaymentMethod" USING ("paymentMethod"::"PaymentMethod"),
  ALTER COLUMN "paymentStatus" TYPE "PaymentStatus" USING ("paymentStatus"::"PaymentStatus");

ALTER TABLE "Order" ALTER COLUMN "paymentStatus" SET DEFAULT 'unpaid';
