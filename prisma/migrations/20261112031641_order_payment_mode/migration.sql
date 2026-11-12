/*
  M2-T4: record which payment mode handled an order, and make mock data structurally distinguishable.

  - "Order"."paymentMode" is NULLABLE with no backfill: orders created before this migration stay
    NULL = "legacy / unclassified". Nothing is guessed (an old razorpay order may have been test or live).
  - New orders get the mode from trusted server configuration (never from the client).
  - CHECK constraints (not modelled by Prisma, so they do not show up in `prisma migrate diff`):
      * mode and method must agree: request_only <-> cod, mock/razorpay_test/razorpay_live <-> razorpay;
      * a mock order can never carry Razorpay identifiers, so it cannot masquerade as a gateway payment;
      * a Payment's provider and mode must agree;
      * a mock payment can only carry a "mock_pay_" gateway id, which can never collide with a real one.
  Purely additive: existing rows satisfy every constraint (new column is NULL; Payment is new and empty in
  production). Rollback: ALTER TABLE ... DROP CONSTRAINT <names below>; ALTER TABLE "Order" DROP COLUMN "paymentMode".
*/

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentMode" "PaymentMode";

-- AddConstraint
ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentMode_method_check" CHECK (
  "paymentMode" IS NULL
  OR ("paymentMode" = 'request_only' AND "paymentMethod" = 'cod')
  OR ("paymentMode" IN ('mock', 'razorpay_test', 'razorpay_live') AND "paymentMethod" = 'razorpay')
);

ALTER TABLE "Order" ADD CONSTRAINT "Order_mock_no_gateway_ids_check" CHECK (
  "paymentMode" IS DISTINCT FROM 'mock' OR ("razorpayOrderId" IS NULL AND "razorpayPaymentId" IS NULL)
);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_provider_mode_check" CHECK (
  ("provider" = 'mock' AND "mode" = 'mock')
  OR ("provider" = 'request_only' AND "mode" = 'request_only')
  OR ("provider" = 'razorpay' AND "mode" IN ('razorpay_test', 'razorpay_live'))
);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_mock_payment_id_check" CHECK (
  "provider" <> 'mock' OR "providerPaymentId" IS NULL OR "providerPaymentId" LIKE 'mock\_pay\_%'
);
