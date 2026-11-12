/*
  M3: quantity-aware inventory (ADR 0011) and order idempotency keys.

  - "Variant"."trackInventory" (default false), "stockQuantity", "reserved": existing variants stay on the legacy
    manual "inStock" flag until staff enable tracking, so deploying this changes no behaviour by itself.
  - "InventoryMovement": append-only ledger of every stock/reservation change. FK to Variant is RESTRICT; the order FK is
    SET NULL so ledger sums stay equal to the counters even if an order row is removed.
  - "IdempotencyKey": replay protection for POST /api/orders. Only a hash of the client key is stored.
  - Hand-added CHECK constraints (not modelled by Prisma, so absent from `migrate diff`):
      Variant: stock >= 0, reserved >= 0, reserved <= stock; untracked variants hold no counts.
      InventoryMovement: each reason has a fixed sign pattern; adjustments need a note.
  Purely additive. Rollback: drop the CHECKs, the two tables, the enum, the index and the three columns.
*/

-- CreateEnum
CREATE TYPE "InventoryReason" AS ENUM ('adjustment', 'reserve', 'release', 'fulfil');

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "reserved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stockQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "orderId" TEXT,
    "reason" "InventoryReason" NOT NULL,
    "stockDelta" INTEGER NOT NULL,
    "reservedDelta" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "note" TEXT,
    "actorType" "OrderActorType" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "orderId" TEXT,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryMovement_variantId_createdAt_idx" ON "InventoryMovement"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_orderId_idx" ON "InventoryMovement"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_keyHash_key" ON "IdempotencyKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_orderId_key" ON "IdempotencyKey"("orderId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddConstraint: no negative stock, no over-reservation, untracked variants carry no counts
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_inventory_counts_check" CHECK (
  "stockQuantity" >= 0 AND "reserved" >= 0 AND "reserved" <= "stockQuantity"
  AND ("trackInventory" OR ("stockQuantity" = 0 AND "reserved" = 0))
);

-- AddConstraint: ledger row shapes (orderId may later become NULL if an order row is removed, so it is not part of the check)
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_shape_check" CHECK (
  "stockAfter" >= 0 AND "reservedAfter" >= 0 AND "reservedAfter" <= "stockAfter" AND (
    ("reason" = 'adjustment' AND "stockDelta" <> 0 AND "reservedDelta" = 0 AND "note" IS NOT NULL AND length(btrim("note")) > 0)
    OR ("reason" = 'reserve' AND "stockDelta" = 0 AND "reservedDelta" > 0)
    OR ("reason" = 'release' AND "stockDelta" = 0 AND "reservedDelta" < 0)
    OR ("reason" = 'fulfil' AND "stockDelta" < 0 AND "reservedDelta" = "stockDelta")
  )
);
