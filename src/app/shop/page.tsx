import type { Metadata } from "next";
import { getProducts, parseCatalogQuery } from "@/lib/catalog";
import { categoryMap } from "@/data/categories";
import { PageHeader } from "@/components/ui/PageHeader";
import { ShopClient } from "@/components/shop/ShopClient";
import type { CategorySlug } from "@/data/types";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function titleFor(cats?: CategorySlug[]) {
  if (!cats?.length) return "Shop all";
  if (cats.length === 2 && cats.includes("nuts") && cats.includes("seeds")) return "Nuts & seeds";
  return cats.map((c) => categoryMap[c].short).join(" & ");
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  const q = parseCatalogQuery(await searchParams);
  const t = titleFor(q.categories);
  return { title: t === "Shop all" ? "Shop" : t, description: "Shop Velora Valley dry fruits, nuts, dates, seeds, ready-to-cook foods, biscuits, chocolates and fruit products." };
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SP> }) {
  const q = parseCatalogQuery(await searchParams);
  const products = await getProducts();
  const single = q.categories?.length === 1 ? categoryMap[q.categories[0]] : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Shop", href: q.categories ? "/shop" : undefined }, ...(q.categories ? [{ label: titleFor(q.categories) }] : [])]}
        script={single ? "From the valley" : "The full range"}
        title={titleFor(q.categories)}
        intro={
          single?.blurb ?? (
            <>
              Dry fruits, nuts, dates, seeds, ready-to-cook foods, biscuits, chocolates and fruit products from Velora Valley.{" "}
              <span className="text-forest/60">Prices shown are brochure MRPs, inclusive of all taxes.</span>
            </>
          )
        }
        photos={[single?.image ?? "/images/products/kimia-dates/lifestyle.webp", "/images/products/california-almonds/lifestyle.webp"]}
      />
      <ShopClient
        products={products}
        initial={{ q: q.q ?? "", cats: q.categories ?? [], sort: q.sort ?? "featured", max: q.maxPrice ?? null }}
      />
    </>
  );
}
