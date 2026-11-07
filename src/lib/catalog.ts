import "server-only";
import type { Prisma, Product, Variant } from "@prisma/client";
import { db } from "./db";
import { isCategorySlug } from "@/data/categories";
import type { CategorySlug, ProductView } from "@/data/types";

type ProductWithVariants = Product & { variants: Variant[] };

export function toView(p: ProductWithVariants): ProductView {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    primaryCategory: p.primaryCategory as CategorySlug,
    categories: JSON.parse(p.categories),
    images: JSON.parse(p.images),
    uses: JSON.parse(p.uses),
    note: p.note,
    featured: p.featured,
    variants: [...p.variants]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        label: v.label,
        weightGrams: v.weightGrams,
        price: v.price,
        mrp: v.mrp,
        shelfLife: v.shelfLife,
        hsCode: v.hsCode,
        image: v.image,
        inStock: v.inStock,
      })),
  };
}

export type SortKey = "featured" | "price-asc" | "price-desc" | "name";

export interface CatalogQuery {
  q?: string;
  categories?: CategorySlug[];
  sort?: SortKey;
  inStockOnly?: boolean;
  maxPrice?: number; // rupees
}

export function parseCatalogQuery(sp: Record<string, string | string[] | undefined>): CatalogQuery {
  const get = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const cats = (get("category") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isCategorySlug);
  const sort = get("sort");
  const max = Number(get("max"));
  return {
    q: get("q")?.slice(0, 80) || undefined,
    categories: cats.length ? cats : undefined,
    sort: (["featured", "price-asc", "price-desc", "name"] as const).includes(sort as SortKey) ? (sort as SortKey) : "featured",
    maxPrice: Number.isFinite(max) && max > 0 ? max : undefined,
  };
}

export async function getProducts(query: CatalogQuery = {}): Promise<ProductView[]> {
  const where: Prisma.ProductWhereInput = { active: true };
  const rows = await db.product.findMany({ where, include: { variants: true }, orderBy: { sortOrder: "asc" } });
  let list = rows.map(toView);

  if (query.categories?.length) {
    list = list.filter((p) => p.categories.some((c) => query.categories!.includes(c)));
  }
  if (query.q) {
    const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = `${p.name} ${p.tagline} ${p.description} ${p.categories.join(" ")} ${p.variants.map((v) => v.label).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (query.maxPrice) {
    const cap = query.maxPrice * 100;
    list = list.filter((p) => p.variants.some((v) => v.price <= cap));
  }
  const minPrice = (p: ProductView) => Math.min(...p.variants.map((v) => v.price));
  switch (query.sort) {
    case "price-asc":
      list.sort((a, b) => minPrice(a) - minPrice(b));
      break;
    case "price-desc":
      list.sort((a, b) => minPrice(b) - minPrice(a));
      break;
    case "name":
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      list.sort((a, b) => Number(b.featured) - Number(a.featured));
  }
  return list;
}

export async function getProduct(slug: string) {
  const p = await db.product.findUnique({ where: { slug }, include: { variants: true } });
  return p && p.active ? toView(p) : null;
}

export async function getFeatured(limit = 10) {
  const rows = await db.product.findMany({
    where: { active: true, featured: true },
    include: { variants: true },
    orderBy: { sortOrder: "asc" },
    take: limit,
  });
  return rows.map(toView);
}

export async function getRelated(product: ProductView, limit = 4) {
  const all = await getProducts({ categories: [product.primaryCategory] });
  const others = all.filter((p) => p.slug !== product.slug);
  if (others.length >= limit) return others.slice(0, limit);
  const extra = (await getFeatured(12)).filter((p) => p.slug !== product.slug && !others.some((o) => o.slug === p.slug));
  return [...others, ...extra].slice(0, limit);
}

export async function getCategoryCounts() {
  const all = await getProducts();
  const counts: Record<string, number> = {};
  for (const p of all) for (const c of p.categories) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}
