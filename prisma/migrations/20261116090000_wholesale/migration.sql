/*
  M6: wholesale accounts, price lists with quantity tiers, MOQ / case packs and quotations (ADR 0014).

  - "BusinessAccount": applied for / created from an enquiry, approved by staff; linked to a verified customer or, until
    that person signs in, to a contact email. A partial unique index keeps one live account per GSTIN.
  - "PriceList" / "PriceListItem": per-variant price tiers (highest minQty <= quantity applies). "VariantWholesale": MOQ and case pack.
  - "Quote" / "QuoteItem" / "QuoteEvent": requested -> quoted -> accepted (creates an order) / declined / expired ...
  - "Order"."businessAccountId": nullable; retail and guest orders stay NULL.
  - Hand-added CHECKs and the partial index are not modelled by Prisma, so they are absent from `migrate diff`.
  Purely additive. Rollback: drop the FK/column on "Order", the new tables and enums.
*/

-- CreateEnum
CREATE TYPE "BusinessAccountStatus" AS ENUM ('pending', 'approved', 'rejected', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('prepaid', 'credit');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('requested', 'quoted', 'accepted', 'declined', 'expired', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "businessAccountId" TEXT;

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListItem" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,

    CONSTRAINT "PriceListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantWholesale" (
    "variantId" TEXT NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "casePack" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantWholesale_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "BusinessAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "contactEmail" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "interest" TEXT,
    "message" TEXT,
    "status" "BusinessAccountStatus" NOT NULL DEFAULT 'pending',
    "priceListId" TEXT,
    "paymentTerms" "PaymentTerms" NOT NULL DEFAULT 'prepaid',
    "creditLimit" INTEGER NOT NULL DEFAULT 0,
    "adminNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "businessAccountId" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'requested',
    "requestNote" TEXT,
    "buyerNote" TEXT,
    "deliveryFee" INTEGER,
    "subtotal" INTEGER,
    "total" INTEGER,
    "validUntil" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantLabel" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER,
    "lineTotal" INTEGER,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteEvent" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "fromStatus" "QuoteStatus" NOT NULL,
    "toStatus" "QuoteStatus" NOT NULL,
    "actorType" "OrderActorType" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_name_key" ON "PriceList"("name");

-- CreateIndex
CREATE INDEX "PriceListItem_variantId_idx" ON "PriceListItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListItem_priceListId_variantId_minQty_key" ON "PriceListItem"("priceListId", "variantId", "minQty");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAccount_customerId_key" ON "BusinessAccount"("customerId");

-- CreateIndex
CREATE INDEX "BusinessAccount_contactEmail_idx" ON "BusinessAccount"("contactEmail");

-- CreateIndex
CREATE INDEX "BusinessAccount_status_createdAt_idx" ON "BusinessAccount"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_number_key" ON "Quote"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_orderId_key" ON "Quote"("orderId");

-- CreateIndex
CREATE INDEX "Quote_businessAccountId_createdAt_idx" ON "Quote"("businessAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_status_validUntil_idx" ON "Quote"("status", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteItem_quoteId_variantId_key" ON "QuoteItem"("quoteId", "variantId");

-- CreateIndex
CREATE INDEX "QuoteEvent_quoteId_createdAt_idx" ON "QuoteEvent"("quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_businessAccountId_createdAt_idx" ON "Order"("businessAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantWholesale" ADD CONSTRAINT "VariantWholesale_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccount" ADD CONSTRAINT "BusinessAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccount" ADD CONSTRAINT "BusinessAccount_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteEvent" ADD CONSTRAINT "QuoteEvent_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live (pending, approved or suspended) account per GSTIN; rejected and closed ones free it
CREATE UNIQUE INDEX "BusinessAccount_one_live_gstin" ON "BusinessAccount"("gstin") WHERE "status" IN ('pending', 'approved', 'suspended');

-- Price and quantity sanity
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_values_check" CHECK ("minQty" >= 1 AND "unitPrice" > 0);
ALTER TABLE "VariantWholesale" ADD CONSTRAINT "VariantWholesale_values_check" CHECK ("moq" >= 1 AND "casePack" >= 1);
ALTER TABLE "BusinessAccount" ADD CONSTRAINT "BusinessAccount_credit_check" CHECK ("creditLimit" >= 0);
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_values_check" CHECK ("quantity" >= 1 AND ("unitPrice" IS NULL OR "unitPrice" > 0));
-- A quote that has been priced (quoted, accepted) carries its totals and an expiry
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_priced_check" CHECK ("status" NOT IN ('quoted', 'accepted') OR ("total" IS NOT NULL AND "subtotal" IS NOT NULL AND "deliveryFee" IS NOT NULL AND "validUntil" IS NOT NULL));
