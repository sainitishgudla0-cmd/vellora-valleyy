import "server-only";
import { Prisma, type InventoryReason, type OrderActorType } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * The only writer of `Variant.stockQuantity` / `Variant.reserved` (M3, ADR 0011; enforced by
 * tests/unit/inventory-ratchet.test.ts). Every change is one guarded UPDATE plus one append-only ledger row, so
 * SUM(ledger) always equals the counters. The UPDATE's WHERE clause is the concurrency guard: it re-checks the
 * invariants against the row as locked, so parallel writers cannot oversell (the DB CHECK is the backstop). The
 * legacy `inStock` column is kept equal to "units available > 0" for tracked variants, so code that still reads it stays right.
 */
export type InventoryTx = Prisma.TransactionClient;

export interface StockActor {
  type: OrderActorType;
  id?: string;
}

export interface StockChange {
  variantId: string;
  reason: InventoryReason;
  stockDelta: number;
  reservedDelta: number;
  orderId?: string;
  note?: string;
  actor: StockActor;
}

/** Applies one change. Returns null (and writes nothing) if the variant is untracked or the change would break an invariant. */
export async function applyStockChange(tx: InventoryTx, c: StockChange): Promise<{ stockAfter: number; reservedAfter: number } | null> {
  const rows = await tx.$queryRaw<{ stockQuantity: number; reserved: number }[]>(Prisma.sql`
    UPDATE "Variant"
    SET "stockQuantity" = "stockQuantity" + ${c.stockDelta}::int, "reserved" = "reserved" + ${c.reservedDelta}::int,
        "inStock" = ("stockQuantity" + ${c.stockDelta}::int) - ("reserved" + ${c.reservedDelta}::int) > 0
    WHERE "id" = ${c.variantId}
      AND "trackInventory"
      AND "stockQuantity" + ${c.stockDelta}::int >= 0
      AND "reserved" + ${c.reservedDelta}::int >= 0
      AND "reserved" + ${c.reservedDelta}::int <= "stockQuantity" + ${c.stockDelta}::int
    RETURNING "stockQuantity", "reserved"`);
  if (rows.length !== 1) return null;
  const { stockQuantity: stockAfter, reserved: reservedAfter } = rows[0];
  await tx.inventoryMovement.create({
    data: {
      variantId: c.variantId,
      orderId: c.orderId ?? null,
      reason: c.reason,
      stockDelta: c.stockDelta,
      reservedDelta: c.reservedDelta,
      stockAfter,
      reservedAfter,
      note: c.note?.trim() || null,
      actorType: c.actor.type,
      actorId: c.actor.id ?? null,
    },
  });
  return { stockAfter, reservedAfter };
}

export interface LedgerDrift {
  variantId: string;
  stockQuantity: number;
  reserved: number;
  ledgerStock: number;
  ledgerReserved: number;
}

/** Variants whose counters disagree with the sum of their ledger. Empty = healthy. For tests and operator checks. */
export async function findLedgerDrift(client: Pick<typeof db, "$queryRaw"> = db): Promise<LedgerDrift[]> {
  return client.$queryRaw<LedgerDrift[]>(Prisma.sql`
    SELECT v."id" AS "variantId", v."stockQuantity", v."reserved",
           COALESCE(SUM(m."stockDelta"), 0)::int AS "ledgerStock", COALESCE(SUM(m."reservedDelta"), 0)::int AS "ledgerReserved"
    FROM "Variant" v LEFT JOIN "InventoryMovement" m ON m."variantId" = v."id"
    GROUP BY v."id"
    HAVING v."stockQuantity" <> COALESCE(SUM(m."stockDelta"), 0) OR v."reserved" <> COALESCE(SUM(m."reservedDelta"), 0)`);
}
