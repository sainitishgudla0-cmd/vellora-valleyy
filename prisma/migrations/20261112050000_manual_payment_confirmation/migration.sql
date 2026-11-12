/*
  M2-T6: staff-confirmed (manual) payments for request-only orders, with an audit trail.

  - "Payment"."manualReference": the external reference (UPI/bank/cash-receipt id) a staff member entered when
    confirming a pay-on-delivery payment. UNIQUE (NULLs allowed many times): one external payment cannot confirm
    two orders.
  - CHECK: only request-only attempts can carry a manual reference. Gateway (razorpay) and mock payments are
    confirmed by their providers only.
  - "OrderEvent"."paymentReference": the same reference on the audit event.
  Purely additive. Rollback: drop the constraint, the index and both columns.
*/

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "manualReference" TEXT;

-- AlterTable
ALTER TABLE "OrderEvent" ADD COLUMN     "paymentReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_manualReference_key" ON "Payment"("manualReference");

-- AddConstraint
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_manual_reference_request_only_check" CHECK ("manualReference" IS NULL OR "provider" = 'request_only');
