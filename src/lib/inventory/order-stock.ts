import "server-only";
import type { OrderStatus } from "@prisma/client";
import { applyStockChange, type InventoryTx, type StockActor } from "./ledger";

/** Thrown when the ledger says an order holds units that the counters cannot give back: data corruption, never expected. */
export class InventoryInvariantError extends Error {}

export interface ReserveLine {
  variantId: string;
  quantity: number;
}

/**
 * Holds units for a new order, inside the order-creating transaction. Lines are processed in a fixed order so
 * concurrent orders cannot deadlock. Returns the first line that cannot be satisfied (the caller rolls back), else null.
 */
export async function reserveForOrder(tx: InventoryTx, orderId: string, lines: ReserveLine[], actor: StockActor): Promise<ReserveLine | null> {
  for (const line of [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
    const r = await applyStockChange(tx, { variantId: line.variantId, reason: "reserve", stockDelta: 0, reservedDelta: line.quantity, orderId, actor });
    if (!r) return line;
  }
  return null;
}

/**
 * Inventory side effects of an order status change, run by the state machine inside the same transaction as the
 * status update so stock can never disagree with the order:
 *  - cancelled (before dispatch): give back what the order still holds;
 *  - dispatched: the held units leave the warehouse (stock and reservation both drop).
 * What an order holds is read from the ledger (SUM of its reservedDelta per variant), so legacy orders and
 * untracked variants have nothing to release, and a repeat call is a no-op.
 */
export async function applyOrderInventoryEffects(tx: InventoryTx, change: { orderId: string; from: OrderStatus; to: OrderStatus; actor: StockActor }): Promise<void> {
  const kind = change.to === "cancelled" && change.from !== "dispatched" ? "release" : change.to === "dispatched" ? "fulfil" : null;
  if (kind) await moveHeldUnits(tx, change.orderId, kind, change.actor);
}

/**
 * Gives back every unit the given orders still hold, whatever their status. For code that deletes orders
 * (test-data cleanup): deleting an order that holds units would otherwise lock them forever.
 */
export async function releaseHoldsForOrders(tx: InventoryTx, orderIds: string[], actor: StockActor): Promise<void> {
  for (const id of orderIds) await moveHeldUnits(tx, id, "release", actor);
}

async function moveHeldUnits(tx: InventoryTx, orderId: string, kind: "release" | "fulfil", actor: StockActor): Promise<void> {
  const held = await tx.inventoryMovement.groupBy({ by: ["variantId"], where: { orderId }, _sum: { reservedDelta: true }, orderBy: { variantId: "asc" } });
  for (const row of held) {
    const qty = row._sum.reservedDelta ?? 0;
    if (qty <= 0) continue;
    const r = await applyStockChange(tx, { variantId: row.variantId, reason: kind, stockDelta: kind === "fulfil" ? -qty : 0, reservedDelta: -qty, orderId, actor });
    if (!r) throw new InventoryInvariantError(`Order ${orderId} holds ${qty} unit(s) of a variant that cannot release them`);
  }
}
