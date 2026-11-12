/*
  M7: GST snapshot, invoices, shipping rules, shipments and the notification outbox (ADR 0015).

  - "OrderItem" and "Order" gain nullable GST snapshot columns (NULL = no rate configured at order time), guarded by CHECKs:
    the parts always add up to the amount exactly, and CGST/SGST and IGST never coexist. Existing rows stay NULL.
  - "TaxRate": append-only rate per HSN code / DELIVERY from a date. "InvoiceSeries" + "Invoice": gap-free numbering per financial year
    (the counter advances in the invoice's own transaction); one invoice per order.
  - "ShippingRule": pincode serviceability and fees. "Shipment" / "ShipmentEvent": courier, AWB, tracking history.
  - "OutboxMessage": transactional notification queue with retry bookkeeping and a unique dedupe key.
  Purely additive. Rollback: drop the new tables/enums and the added columns.
*/

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryCgst" INTEGER,
ADD COLUMN     "deliveryGstRateBp" INTEGER,
ADD COLUMN     "deliveryIgst" INTEGER,
ADD COLUMN     "deliverySgst" INTEGER,
ADD COLUMN     "deliveryTaxable" INTEGER,
ADD COLUMN     "supplyType" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "cgst" INTEGER,
ADD COLUMN     "gstRateBp" INTEGER,
ADD COLUMN     "hsCode" TEXT,
ADD COLUMN     "igst" INTEGER,
ADD COLUMN     "sgst" INTEGER,
ADD COLUMN     "taxableValue" INTEGER;

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSeries" (
    "financialYear" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceSeries_pkey" PRIMARY KEY ("financialYear")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "supplyType" TEXT NOT NULL,
    "taxableTotal" INTEGER NOT NULL,
    "cgstTotal" INTEGER NOT NULL,
    "sgstTotal" INTEGER NOT NULL,
    "igstTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "buyerGstin" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pincodePrefix" TEXT NOT NULL DEFAULT '',
    "serviceable" BOOLEAN NOT NULL DEFAULT true,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "freeAboveSubtotal" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "trackingUrl" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'created',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "template" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_code_effectiveFrom_key" ON "TaxRate"("code", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_financialYear_seq_key" ON "Invoice"("financialYear", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingRule_pincodePrefix_key" ON "ShippingRule"("pincodePrefix");

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_courier_awb_key" ON "Shipment"("courier", "awb");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_createdAt_idx" ON "ShipmentEvent"("shipmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- GST snapshot integrity: all-or-none, parts add up exactly, intra-state (CGST+SGST) and inter-state (IGST) never mix
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_gst_snapshot_check" CHECK (
  ("gstRateBp" IS NULL AND "taxableValue" IS NULL AND "cgst" IS NULL AND "sgst" IS NULL AND "igst" IS NULL)
  OR ("gstRateBp" IS NOT NULL AND "taxableValue" IS NOT NULL AND "cgst" IS NOT NULL AND "sgst" IS NOT NULL AND "igst" IS NOT NULL
      AND "gstRateBp" BETWEEN 0 AND 5000
      AND "taxableValue" >= 0 AND "cgst" >= 0 AND "sgst" >= 0 AND "igst" >= 0
      AND "taxableValue" + "cgst" + "sgst" + "igst" = "lineTotal"
      AND ("igst" = 0 OR ("cgst" = 0 AND "sgst" = 0)))
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_delivery_gst_check" CHECK (
  ("deliveryGstRateBp" IS NULL AND "deliveryTaxable" IS NULL AND "deliveryCgst" IS NULL AND "deliverySgst" IS NULL AND "deliveryIgst" IS NULL)
  OR ("deliveryGstRateBp" IS NOT NULL AND "deliveryTaxable" IS NOT NULL AND "deliveryCgst" IS NOT NULL AND "deliverySgst" IS NOT NULL AND "deliveryIgst" IS NOT NULL
      AND "deliveryGstRateBp" BETWEEN 0 AND 5000
      AND "deliveryTaxable" >= 0 AND "deliveryCgst" >= 0 AND "deliverySgst" >= 0 AND "deliveryIgst" >= 0
      AND "deliveryTaxable" + "deliveryCgst" + "deliverySgst" + "deliveryIgst" = "deliveryFee"
      AND ("deliveryIgst" = 0 OR ("deliveryCgst" = 0 AND "deliverySgst" = 0)))
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_supply_type_check" CHECK ("supplyType" IS NULL OR "supplyType" IN ('intra', 'inter'));

ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_values_check" CHECK ("rateBp" BETWEEN 0 AND 5000 AND length("code") BETWEEN 1 AND 12);
ALTER TABLE "InvoiceSeries" ADD CONSTRAINT "InvoiceSeries_seq_check" CHECK ("lastSeq" >= 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_values_check" CHECK ("seq" >= 1 AND "supplyType" IN ('intra', 'inter') AND "total" = "taxableTotal" + "cgstTotal" + "sgstTotal" + "igstTotal" AND length("number") <= 16);
ALTER TABLE "ShippingRule" ADD CONSTRAINT "ShippingRule_values_check" CHECK ("fee" >= 0 AND ("freeAboveSubtotal" IS NULL OR "freeAboveSubtotal" > 0) AND "pincodePrefix" ~ '^[0-9]{0,6}$');
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_attempts_check" CHECK ("attempts" >= 0);
