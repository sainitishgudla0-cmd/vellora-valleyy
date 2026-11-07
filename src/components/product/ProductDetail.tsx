"use client";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductView } from "@/data/types";
import { categoryMap } from "@/data/categories";
import { site } from "@/config/site";
import { cn, formatPrice } from "@/lib/format";
import { QuantityStepper } from "./QuantityStepper";
import { AddToCartButton } from "./AddToCartButton";
import { IconCheck, IconLeaf, IconTruck } from "@/components/ui/Icons";

export function ProductDetail({ product }: { product: ProductView }) {
  const [vi, setVi] = useState(0);
  const [qty, setQty] = useState(1);
  const variant = product.variants[vi];

  const images = useMemo(() => {
    const list: { src: string; contain: boolean; label: string }[] = [];
    list.push({ src: variant.image ?? product.images.lifestyle, contain: false, label: `${product.name} ${variant.label}` });
    if (!variant.image) {
      if (product.images.front) list.push({ src: product.images.front, contain: true, label: `${product.name} pack front` });
      if (product.images.back) list.push({ src: product.images.back, contain: true, label: `${product.name} pack back` });
      product.images.gallery?.forEach((g, i) => list.push({ src: g, contain: true, label: `${product.name} — brand image ${i + 1}` }));
    }
    return list;
  }, [product, variant]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [vi]);
  const img = images[Math.min(active, images.length - 1)];

  // cursor-follow zoom
  const zoomRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);

  // mobile sticky bar visibility
  const buyRef = useRef<HTMLDivElement>(null);
  const [showBar, setShowBar] = useState(false);
  useEffect(() => {
    const el = buyRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setShowBar(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const facts: [string, string][] = [
    ["Pack size", variant.label],
    [variant.price === variant.mrp ? "MRP" : "Price", `${formatPrice(variant.price)} (incl. of all taxes)`],
    ["Shelf life", variant.shelfLife.charAt(0).toUpperCase() + variant.shelfLife.slice(1)],
    ["Barcode", variant.sku],
    ["HS code", variant.hsCode],
    ["FSSAI Lic. No.", site.fssaiLicense],
    ["Packed by", `${site.company}, ${site.address.city}, ${site.address.state}`],
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14">
        {/* gallery */}
        <div className="lg:sticky lg:top-[100px] lg:self-start">
          <div
            ref={zoomRef}
            className="relative aspect-square cursor-zoom-in overflow-hidden rounded-[18px] bg-white"
            onMouseMove={(e) => {
              const r = zoomRef.current!.getBoundingClientRect();
              setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
            }}
            onMouseLeave={() => setZoom(null)}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={img.src}
                initial={{ opacity: 0, scale: 1.04 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-0"
              >
                <Image
                  src={img.src}
                  alt={img.label}
                  fill
                  priority
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className={cn("transition-transform duration-300 ease-out", img.contain ? "object-contain p-6" : "object-cover")}
                  style={zoom ? { transform: "scale(1.8)", transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined}
                />
              </motion.div>
            </AnimatePresence>
            <span className="eyebrow pointer-events-none absolute left-4 top-4 rounded-full bg-cream-light/90 px-3 py-1.5 text-[10px]">
              {categoryMap[product.primaryCategory]?.short}
            </span>
          </div>
          {images.length > 1 && (
            <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Product images">
              {images.map((im, i) => (
                <button
                  key={im.src}
                  role="tab"
                  aria-selected={i === active}
                  aria-label={`Show ${im.label}`}
                  onClick={() => setActive(i)}
                  className={cn(
                    "relative h-20 w-20 shrink-0 overflow-hidden rounded-[10px] border-2 bg-white transition-all duration-300",
                    i === active ? "border-forest" : "border-transparent opacity-70 hover:opacity-100",
                  )}
                >
                  <Image src={im.src} alt="" fill sizes="80px" className={im.contain ? "object-contain p-1" : "object-cover"} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* info */}
        <div>
          <Link href={`/shop?category=${product.primaryCategory}`} className="eyebrow link-underline text-leaf">
            {categoryMap[product.primaryCategory]?.name}
          </Link>
          <h1 className="mt-3 text-[clamp(3rem,6vw,5.5rem)] leading-[0.86]">{product.name}</h1>
          <p className="script mt-2 text-[34px] text-leaf">{product.tagline}</p>

          <div className="mt-6 flex items-end gap-3">
            <span className="display text-[56px] leading-[0.8]">{formatPrice(variant.price)}</span>
            {variant.price < variant.mrp && <s className="mb-1 text-[14px] text-forest/50">MRP {formatPrice(variant.mrp)}</s>}
            <span className="mb-1 text-[12px] text-forest/60">{variant.price === variant.mrp ? "MRP · incl. of all taxes" : "incl. of all taxes"}</span>
          </div>

          <p className="mt-6 max-w-[52ch] text-[14.5px] leading-relaxed text-forest/85">{product.description}</p>

          {product.variants.length > 1 && (
            <fieldset className="mt-7">
              <legend className="label">Pack size</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {product.variants.map((v, i) => (
                  <label
                    key={v.id}
                    className={cn(
                      "cursor-pointer rounded-[12px] border-[1.5px] px-4 py-2.5 transition-all duration-300 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold",
                      i === vi ? "border-forest bg-forest text-cream" : "border-forest/25 hover:border-forest",
                    )}
                  >
                    <input type="radio" name="pack" className="sr-only" checked={i === vi} onChange={() => setVi(i)} />
                    <span className="display block text-[22px] leading-none">{v.label}</span>
                    <span className="text-[12px] opacity-75">{formatPrice(v.price)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div ref={buyRef} className="mt-7 flex flex-wrap items-center gap-3">
            <QuantityStepper value={qty} onChange={setQty} />
            <AddToCartButton product={product} variant={variant} quantity={qty} size="lg" className="min-w-[220px] flex-1" openDrawer />
          </div>

          {product.note && (
            <p className="mt-4 rounded-[10px] bg-butter px-4 py-3 text-[12.5px] leading-snug">
              <strong className="font-medium">Please note: </strong>
              {product.note}
            </p>
          )}

          <ul className="mt-6 grid grid-cols-1 gap-2 text-[12.5px] text-forest/80 sm:grid-cols-2">
            <li className="flex items-start gap-2">
              <IconTruck width={18} className="mt-0.5 shrink-0 text-leaf" /> {site.delivery.note}
            </li>
            <li className="flex items-start gap-2">
              <IconLeaf width={18} className="mt-0.5 shrink-0 text-leaf" /> Packed by {site.company} in hygienic, sealed packaging.
            </li>
          </ul>

          {product.uses.length > 0 && (
            <div className="mt-9 rounded-[14px] bg-sage p-[5px]">
              <div className="rounded-[10px] border-[1.5px] border-forest/60 p-5">
                <h2 className="text-[30px] leading-none">Ways to enjoy</h2>
                <ul className="mt-3 space-y-2">
                  {product.uses.map((u) => (
                    <li key={u} className="flex items-start gap-2.5 text-[13.5px]">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest text-cream">
                        <IconCheck width={12} />
                      </span>
                      {u}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="mt-9">
            <h2 className="text-[30px] leading-none">Product details</h2>
            <dl className="mt-4 divide-y divide-dashed divide-forest/25 border-y border-dashed border-forest/25 text-[13px]">
              {facts.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[130px_1fr] gap-4 py-2.5">
                  <dt className="text-forest/60">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11.5px] text-forest/55">
              Ingredients, nutrition and allergen information are printed on the pack. Please read the label before use.
            </p>
          </div>
        </div>
      </div>

      {/* mobile sticky buy bar */}
      <AnimatePresence>
        {showBar && (
          <motion.div
            initial={{ y: "110%" }}
            animate={{ y: 0 }}
            exit={{ y: "110%" }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-forest/15 bg-cream-light/95 px-4 py-3 backdrop-blur lg:hidden"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{product.name}</p>
              <p className="text-[12px] text-forest/60">
                {variant.label} · {formatPrice(variant.price)}
              </p>
            </div>
            <AddToCartButton product={product} variant={variant} quantity={qty} size="sm" label="Add" />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
