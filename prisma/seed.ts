/**
 * Seeds / syncs the catalogue from src/data/products.ts.
 * - New products and variants are created.
 * - Existing products keep their admin-edited prices; descriptive fields are refreshed.
 *   Pass --reset-prices to overwrite selling prices with brochure MRPs.
 *
 * Safety: runs only against a disposable database, unless the operator explicitly confirms a production
 * catalogue sync (APP_ENV=production + CONFIRM_PRODUCTION_DB_HOST=<host>). See docs/RUNBOOK-DATABASE.md.
 */
import { PrismaClient } from "@prisma/client";
import { products } from "../src/data/products";
import { assertDatabaseWriteAllowed } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "../scripts/lib/safety";

loadLocalEnv();
let target: ReturnType<typeof assertDatabaseWriteAllowed>;
try {
  target = assertDatabaseWriteAllowed(process.env, "catalogue seed");
} catch (e) {
  console.error(`[seed] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.log(`Seeding catalogue into ${target.host}/${target.database}${target.production ? " (PRODUCTION, explicitly confirmed)" : ""}`);
const db = new PrismaClient();
const resetPrices = process.argv.includes("--reset-prices");

async function main() {
  let order = 0;
  for (const p of products) {
    const data = {
      name: p.name,
      tagline: p.tagline,
      description: p.description,
      primaryCategory: p.primaryCategory,
      categories: JSON.stringify(p.categories),
      images: JSON.stringify(p.images),
      uses: JSON.stringify(p.uses ?? []),
      note: p.note ?? null,
      featured: !!p.featured,
      sortOrder: order++,
    };
    const product = await db.product.upsert({ where: { slug: p.slug }, create: { slug: p.slug, ...data }, update: data });
    let vOrder = 0;
    for (const v of p.variants) {
      const mrp = Math.round(v.mrp * 100);
      const common = {
        label: v.label,
        weightGrams: v.weightGrams,
        mrp,
        shelfLife: v.shelfLife,
        hsCode: v.hsCode,
        image: v.image ?? null,
        sortOrder: vOrder++,
        productId: product.id,
      };
      await db.variant.upsert({
        where: { sku: v.sku },
        create: { sku: v.sku, price: mrp, ...common },
        update: resetPrices ? { ...common, price: mrp } : common,
      });
    }
  }
  const [pc, vc] = await Promise.all([db.product.count(), db.variant.count()]);
  console.log(`Seeded ${pc} products / ${vc} variants`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
