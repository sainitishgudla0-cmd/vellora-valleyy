/*
  M11 P1-T2 (finding F04): dedicated, attested record of offline (request-only) payment collections.

  - "Payment"."manualMethod": how the money was collected (cash, upi, bank_transfer, cheque, card_on_delivery).
  - "Payment"."manualRecordedBy" / "manualRecordedAt": the admin account that recorded it, and when.
  - CHECKs: only request-only attempts can carry these fields; a method needs a reference.
  - Trigger: once a collection is recorded (manualReference set), its reference, method, recorder and time can never be
    changed or cleared, so the record staff relied on cannot be rewritten later. Deleting the row (test-data cleanup,
    order erasure cascades) is not affected.
  Purely additive: existing rows get NULLs (pre-M11 manual confirmations have a reference but no method).
  Rollback: DROP TRIGGER "Payment_manual_record_immutable" ON "Payment"; DROP FUNCTION "payment_manual_record_immutable"();
            drop the two constraints and the three columns.
*/

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "manualMethod" TEXT,
ADD COLUMN     "manualRecordedAt" TIMESTAMP(3),
ADD COLUMN     "manualRecordedBy" TEXT;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_manual_method_check" CHECK (
  "manualMethod" IS NULL OR ("provider" = 'request_only' AND "manualReference" IS NOT NULL AND "manualMethod" IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card_on_delivery'))
);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_manual_recorded_check" CHECK (
  ("manualRecordedBy" IS NULL AND "manualRecordedAt" IS NULL) OR ("provider" = 'request_only' AND "manualRecordedBy" IS NOT NULL AND "manualRecordedAt" IS NOT NULL)
);

CREATE FUNCTION "payment_manual_record_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."manualReference" IS NOT NULL AND (
       NEW."manualReference" IS DISTINCT FROM OLD."manualReference"
    OR (OLD."manualMethod" IS NOT NULL AND NEW."manualMethod" IS DISTINCT FROM OLD."manualMethod")
    OR (OLD."manualRecordedBy" IS NOT NULL AND NEW."manualRecordedBy" IS DISTINCT FROM OLD."manualRecordedBy")
    OR (OLD."manualRecordedAt" IS NOT NULL AND NEW."manualRecordedAt" IS DISTINCT FROM OLD."manualRecordedAt")
  ) THEN
    RAISE EXCEPTION 'a recorded offline payment collection cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "Payment_manual_record_immutable" BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION "payment_manual_record_immutable"();
