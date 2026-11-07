import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProduct, getRelated } from "@/lib/catalog";
import { categoryMap } from "@/data/categories";
import { site } from "@/config/site";
import { ProductDetail } from "@/components/product/ProductDetail";
import { ProductCard } from "@/components/product/ProductCard";

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = await getProduct((await params).slug);
  if (!p) return { title: "Product not found" };
  return {
    title: p.name,
    description: p.description,
    openGraph: { images: [p.images.lifestyle], title: `${p.name} · ${site.name}`, description: p.description },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const product = await getProduct((await params).slug);
  if (!product) notFound();
  const related = await getRelated(product, 4);
  const cat = categoryMap[product.primaryCategory];

  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${site.name} ${product.name}`,
    image: [new URL(product.images.lifestyle, site.url).toString()],
    description: product.description,
    brand: { "@type": "Brand", name: site.name },
    manufacturer: { "@type": "Organization", name: site.company },
    offers: product.variants.map((v) => ({
      "@type": "Offer",
      sku: v.sku,
      gtin13: v.sku,
      name: v.label,
      priceCurrency: "INR",
      price: (v.price / 100).toFixed(2),
      availability: v.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    })),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <div className="container-site pb-20 pt-6 md:pt-10">
        <nav aria-label="Breadcrumb" className="mb-6">
          <ol className="flex flex-wrap items-center gap-2 text-[12px] text-forest/60">
            <li>
              <Link href="/" className="link-underline">
                Home
              </Link>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />
              <Link href="/shop" className="link-underline">
                Shop
              </Link>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />
              <Link href={`/shop?category=${cat.slug}`} className="link-underline">
                {cat.short}
              </Link>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />
              <span aria-current="page" className="text-forest">
                {product.name}
              </span>
            </li>
          </ol>
        </nav>
        <ProductDetail product={product} />
      </div>

      {related.length > 0 && (
        <section className="grain relative bg-sage/60 py-20 md:py-24" aria-labelledby="related-title">
          <div className="edge-dash absolute inset-x-0 top-0" aria-hidden />
          <div className="container-site">
            <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="script -rotate-2 text-[30px] text-leaf">More from the valley</p>
                <h2 id="related-title" className="text-display-md" data-split="words">
                  You may also like
                </h2>
              </div>
              <Link href={`/shop?category=${cat.slug}`} className="btn btn-forest">
                {`All ${cat.short.toLowerCase()}`}
              </Link>
            </div>
            <ul className="grid grid-cols-1 gap-5 min-[480px]:grid-cols-2 lg:grid-cols-4">
              {related.map((p) => (
                <li key={p.id} data-reveal="up">
                  <ProductCard product={p} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}

export async function generateStaticParams() {
  const { products } = await import("@/data/products");
  return products.map((p) => ({ slug: p.slug }));
}
