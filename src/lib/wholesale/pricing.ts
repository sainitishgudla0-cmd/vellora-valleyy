import "server-only";
import { Prisma, type BusinessAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { OrderError, type WholesaleHooks } from "@/lib/orders";
import { outstandingAmount } from "./accounts";
import { NO_RESTRICTION, quantityProblem, resolveUnitPrice, type PriceTier, type QuantityTerms } from "./rules";

type Client = Prisma.TransactionClient | typeof db;

export async function loadQuantityTerms(client: Client, variantIds: string[]): Promise<Map<string, QuantityTerms>> {
  const rows = await client.variantWholesale.findMany({ where: { variantId: { in: variantIds } } });
  return new Map(rows.map((r) => [r.variantId, { moq: r.moq, casePack: r.casePack }]));
}

/** Tiers of the account's ACTIVE price list for the given variants (none when the account has no list). */
export async function loadTiers(client: Client, priceListId: string | null, variantIds: string[]): Promise<Map<string, PriceTier[]>> {
  const out = new Map<string, PriceTier[]>();
  if (!priceListId) return out;
  const items = await client.priceListItem.findMany({ where: { priceListId, priceList: { active: true }, variantId: { in: variantIds } }, orderBy: { minQty: "asc" } });
  for (const i of items) (out.get(i.variantId) ?? out.set(i.variantId, []).get(i.variantId)!).push({ minQty: i.minQty, unitPrice: i.unitPrice });
  return out;
}

/**
 * The price hook for an account's orders: enforces MOQ and case packs (refusing with a 422 that names the item) and
 * resolves each line to the buyer's price-list tier, falling back to the retail price. Runs inside the order transaction.
 */
export function accountPriceLines(account: Pick<BusinessAccount, "priceListId">): WholesaleHooks["priceLines"] {
  return async (tx, lines) => {
    const ids = lines.map((l) => l.variant.id);
    const [terms, tiers] = await Promise.all([loadQuantityTerms(tx, ids), loadTiers(tx, account.priceListId, ids)]);
    const prices = new Map<string, number>();
    for (const { variant, quantity } of lines) {
      const problem = quantityProblem(terms.get(variant.id) ?? NO_RESTRICTION, quantity);
      if (problem) throw new OrderError(`${variant.name} (${variant.label}): ${problem}.`, 422);
      prices.set(variant.id, resolveUnitPrice(variant.price, tiers.get(variant.id) ?? [], quantity).unitPrice);
    }
    return prices;
  };
}

/**
 * Credit-limit check for `credit` terms, serialised per account (row lock) so parallel orders cannot jointly overrun it.
 * Prepaid accounts have no limit here: payment before dispatch is an operational step (confirm the payment, then dispatch).
 */
export function creditCheck(account: Pick<BusinessAccount, "id" | "paymentTerms" | "creditLimit">): NonNullable<WholesaleHooks["beforeCreate"]> {
  return async (tx, { total }) => {
    if (account.paymentTerms !== "credit") return;
    await tx.$queryRaw`SELECT "id" FROM "BusinessAccount" WHERE "id" = ${account.id} FOR UPDATE`;
    const used = await outstandingAmount(tx, account.id);
    if (used + total > account.creditLimit) throw new OrderError("This order would take the account over its credit limit. Please settle outstanding invoices or contact us.", 409);
  };
}
