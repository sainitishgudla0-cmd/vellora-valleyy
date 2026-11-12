/**
 * Test-only inventory fixtures (never imported by application code). Each call creates its own product and variant
 * so tests never touch the seeded catalogue, and stock is set through the real ledger so sums stay consistent.
 */
import { db } from "@/lib/db";
import { updateVariantInventory } from "@/lib/inventory/adjust";

export const FIXTURE_SLUG_PREFIX = "m3-fixture-";
export const FIXTURE_CUSTOMER = "SMOKE TEST Stock";
let seq = 0;
const tag = Date.now().toString(36);

export async function createInventoryVariant(opts: { stock?: number; tracked?: boolean; inStock?: boolean; price?: number; productActive?: boolean } = {}) {
  const n = ++seq;
  const product = await db.product.create({
    data: {
      slug: `${FIXTURE_SLUG_PREFIX}${tag}-${n}`, name: `M3 Fixture ${n}`, tagline: "t", description: "d", primaryCategory: "dry-fruits", categories: "[]", images: "{}",
      active: opts.productActive ?? true,
      variants: { create: { sku: `M3-${tag}-${n}`, label: "250g", weightGrams: 250, price: opts.price ?? 40000, mrp: 50000, shelfLife: "6 months", hsCode: "0802", inStock: opts.inStock ?? true } },
    },
    include: { variants: true },
  });
  const variant = product.variants[0];
  const tracked = opts.tracked ?? true;
  if (tracked) {
    const r = await updateVariantInventory({ variantId: variant.id, actor: { type: "system", id: "test" }, trackInventory: true, reason: "test fixture", stockAdjust: opts.stock ? { delta: opts.stock, reason: "Opening stock" } : undefined });
    if (!r.ok) throw new Error(`fixture: ${r.message}`);
  }
  return { product, variantId: variant.id, name: product.name };
}

export const variantState = (variantId: string) => db.variant.findUniqueOrThrow({ where: { id: variantId }, select: { trackInventory: true, stockQuantity: true, reserved: true, inStock: true } });
export const movements = (variantId: string) => db.inventoryMovement.findMany({ where: { variantId }, orderBy: { createdAt: "asc" } });

export const customer = {
  customerName: FIXTURE_CUSTOMER, email: "smoke.stock@example.com", phone: "9876543210", addressLine1: "1 Test Street",
  city: "Anantapur", state: "Andhra Pradesh" as const, pincode: "515001",
};

export async function cleanupInventoryFixtures() {
  await db.order.deleteMany({ where: { customerName: FIXTURE_CUSTOMER } });
  const variants = await db.variant.findMany({ where: { product: { slug: { startsWith: FIXTURE_SLUG_PREFIX } } }, select: { id: true } });
  const ids = variants.map((v) => v.id);
  await db.inventoryMovement.deleteMany({ where: { variantId: { in: ids } } });
  await db.product.deleteMany({ where: { slug: { startsWith: FIXTURE_SLUG_PREFIX } } });
}
