import "server-only";
import type { BusinessAccount } from "@prisma/client";
import { createOrder, type IdempotencyClaim } from "@/lib/orders";
import type { OrderInput } from "@/lib/validation";
import { accountPriceLines, creditCheck } from "./pricing";

/**
 * A direct wholesale order (no quote): the buyer's price-list prices, MOQ and case packs, stock holds, and the credit limit
 * for credit terms. Payment is offline (request-only attempt): staff confirm it, so there is no online checkout for B2B in M6.
 */
export function placeWholesaleOrder(account: BusinessAccount, customerId: string, input: Omit<OrderInput, "paymentMethod">, idempotency?: IdempotencyClaim) {
  return createOrder(
    { ...input, paymentMethod: "cod" },
    { customerId, idempotency, wholesale: { businessAccountId: account.id, priceLines: accountPriceLines(account), beforeCreate: creditCheck(account) } },
  );
}
