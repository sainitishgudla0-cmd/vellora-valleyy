"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { ProductView } from "@/data/types";
import { categoryMap } from "@/data/categories";
import { cn, formatPrice } from "@/lib/format";
import { useUI } from "@/store/ui";
import { IconArrowRight, IconEye } from "@/components/ui/Icons";
import { AddToCartButton } from "./AddToCartButton";

/**
 * Ticket-style product card: double-outline frame, image swap + zoom on hover,
 * pack/MRP stat row, pack-size chips, add to cart and quick view.
 */
export function ProductCard({
  product,
  tone = "light",
  priority,
  className,
  sizes = "(min-width: 1280px) 22vw, (min-width: 768px) 30vw, 88vw",
}: {
  product: ProductView;
  tone?: "light" | "sage" | "butter";
  priority?: boolean;
  className?: string;
  sizes?: string;
}) {
  const [vi, setVi] = useState(0);
  const variant = product.variants[vi];
  const openQuickView = useUI((s) => s.openQuickView);
  const primary = variant.image ?? product.images.lifestyle;
  const secondary = product.images.front && !variant.image ? product.images.front : null;
  const bg = tone === "sage" ? "bg-sage" : tone === "butter" ? "bg-butter" : "bg-cream-light";
  const href = `/product/${product.slug}`;

  return (
    <article
      className={cn(
        "group/card relative flex h-full flex-col rounded-[14px] p-[5px] text-forest transition-[transform,box-shadow] duration-700 ease-out-expo hover:-translate-y-1.5 hover:shadow-lift",
        bg,
        className,
      )}
    >
      <div className="flex h-full flex-col rounded-[10px] border-[1.5px] border-forest/70 p-3 sm:p-3.5">
        {/* top row */}
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <Link
            href={`/shop?category=${product.primaryCategory}`}
            className="eyebrow rounded-full border border-forest/30 px-2.5 py-1 text-[10px] transition-colors hover:border-forest hover:bg-forest hover:text-cream"
          >
            {categoryMap[product.primaryCategory]?.short}
          </Link>
          <button
            type="button"
            onClick={() => openQuickView(product)}
            className="flex h-8 items-center gap-1.5 rounded-full bg-forest px-3 text-[11px] text-cream transition-all duration-500 ease-out-expo hover:bg-forest-logo lg:translate-y-1 lg:opacity-0 lg:group-hover/card:translate-y-0 lg:group-hover/card:opacity-100 lg:focus-visible:opacity-100"
            aria-label={`Quick view ${product.name}`}
          >
            <IconEye width={14} height={14} /> Quick view
          </button>
        </div>

        {/* image */}
        <Link href={href} className="relative block aspect-square overflow-hidden rounded-[8px] bg-dough" aria-label={product.name}>
          <Image
            src={primary}
            alt={`${product.name} ${variant.label}`}
            fill
            sizes={sizes}
            priority={priority}
            className={cn(
              "object-cover transition-[transform,opacity] duration-[1100ms] ease-out-expo group-hover/card:scale-[1.08]",
              secondary && "group-hover/card:opacity-0",
            )}
          />
          {secondary && (
            <Image
              src={secondary}
              alt=""
              fill
              sizes={sizes}
              className="scale-110 bg-white object-contain p-4 opacity-0 transition-[transform,opacity] duration-[1100ms] ease-out-expo group-hover/card:scale-100 group-hover/card:opacity-100"
            />
          )}
          {product.note?.includes("Buy One Get One") && (
            <span className="absolute left-2 top-2 rounded-full bg-gold px-2 py-1 text-[10px] font-medium uppercase tracking-wider">Brochure offer</span>
          )}
        </Link>

        {/* title */}
        <Link href={href} className="mt-3 block">
          <h3 className="text-[clamp(1.5rem,2.1vw,1.9rem)] leading-[0.92] transition-colors group-hover/card:text-leaf">{product.name}</h3>
          <p className="mt-1 text-[12px] text-forest/65">{product.tagline}</p>
        </Link>

        {/* pack chips */}
        {product.variants.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Pack size">
            {product.variants.map((v, i) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={i === vi}
                onClick={() => setVi(i)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  i === vi ? "border-forest bg-forest text-cream" : "border-forest/30 hover:border-forest",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}

        {/* stats */}
        <div className="mt-auto pt-3">
          <dl className="grid grid-cols-2 border-y-[1.5px] border-dashed border-forest/30 py-2.5 text-center">
            <div className="border-r-[1.5px] border-dashed border-forest/30">
              <dt className="text-[10px] uppercase tracking-wider text-forest/60">Pack</dt>
              <dd className="display text-[22px] leading-none">{variant.label.replace(/\s*\(.*\)/, "")}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-forest/60">{variant.price === variant.mrp ? "MRP" : "Price"}</dt>
              <dd className="display text-[22px] leading-none">
                {formatPrice(variant.price)}
                {variant.price < variant.mrp && <s className="ml-1 font-mono text-[11px] font-normal text-forest/50">{formatPrice(variant.mrp)}</s>}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <AddToCartButton product={product} variant={variant} size="sm" className="flex-1" />
            <Link
              href={href}
              aria-label={`View ${product.name}`}
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-forest/30 transition-all duration-500 ease-out-expo hover:-rotate-45 hover:border-forest hover:bg-forest hover:text-cream"
            >
              <IconArrowRight width={16} />
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
