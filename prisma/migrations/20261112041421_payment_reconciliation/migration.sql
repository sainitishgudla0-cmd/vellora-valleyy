-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "needsReconciliation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconcileReason" TEXT;

-- CreateIndex
CREATE INDEX "Payment_needsReconciliation_createdAt_idx" ON "Payment"("needsReconciliation", "createdAt");
