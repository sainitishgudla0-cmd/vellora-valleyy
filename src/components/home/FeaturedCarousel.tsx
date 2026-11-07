"use client";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductView } from "@/data/types";
import { ProductCard } from "@/components/product/ProductCard";
import { ButtonLink } from "@/components/ui/Button";
import { IconArrowLeft, IconArrowRight } from "@/components/ui/Icons";
import { cn } from "@/lib/format";

/** Forest "shop the valley" section with a scroll-snap product carousel. */
export function FeaturedCarousel({ products }: { products: ProductView[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const [progress, setProgress] = useState(0);

  const update = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft > max - 8 });
    setProgress(max > 0 ? el.scrollLeft / max : 0);
  }, []);

  useEffect(() => {
    update();
    const el = track.current;
    el?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [update]);

  const go = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-slide]");
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? 320) + 20) * (window.innerWidth > 1024 ? 2 : 1), behavior: "smooth" });
  };

  return (
    <section className="grain relative overflow-hidden bg-forest text-cream" aria-labelledby="featured-title">
      <div className="edge-dash [--c:theme(colors.cream.DEFAULT)]" aria-hidden />
      <div className="container-site relative pb-10 pt-20 md:pt-28">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <h2 id="featured-title" className="text-display-xl" data-split="words">
              Shop the valley
            </h2>
            <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-center">
              <p className="max-w-[44ch] text-[14px] text-cream/80" data-reveal="up">
                Cashews, almonds, pistachios and raisins; Safawi and Kimia dates; seeds, chocolates and more — packed by Anantha Food Products
                in Anantapur.
              </p>
              <div data-reveal="up" data-delay="0.1">
                <ButtonLink href="/shop">Shop all products</ButtonLink>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <p className="script hidden -rotate-6 text-[30px] leading-[0.9] text-gold-light xl:block">
              A taste of
              <br />
              the valley
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => go(-1)}
                disabled={edge.start}
                aria-label="Previous products"
                className="flex h-12 w-12 items-center justify-center rounded-full border-[1.5px] border-cream/50 transition-all duration-300 hover:bg-cream hover:text-forest disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cream"
              >
                <IconArrowLeft />
              </button>
              <button
                onClick={() => go(1)}
                disabled={edge.end}
                aria-label="Next products"
                className="flex h-12 w-12 items-center justify-center rounded-full border-[1.5px] border-cream/50 transition-all duration-300 hover:bg-cream hover:text-forest disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cream"
              >
                <IconArrowRight />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={track}
        className="scrollbar-none relative flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-6 pt-4 sm:px-6 lg:px-10 [scroll-padding-inline:16px] sm:[scroll-padding-inline:24px] lg:[scroll-padding-inline:40px]"
        data-lenis-prevent-wheel
        aria-label="Featured products"
        tabIndex={0}
      >
        {products.map((p, i) => (
          <div key={p.id} data-slide className="w-[78vw] max-w-[330px] shrink-0 snap-start sm:w-[44vw] lg:w-[24vw]" data-reveal="up" data-delay={String(Math.min(i, 4) * 0.06)}>
            <div style={{ rotate: `${[-1.2, 0.8, -0.5, 1.1, -0.9][i % 5]}deg` }} className="h-full transition-[rotate] duration-700 hover:[rotate:0deg]">
              <ProductCard product={p} tone="sage" sizes="330px" />
            </div>
          </div>
        ))}
        <div className="w-px shrink-0" aria-hidden />
      </div>

      <div className="container-site relative pb-20 md:pb-28">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-cream/15">
          <div className="h-full origin-left rounded-full bg-gold transition-transform duration-300" style={{ transform: `scaleX(${Math.max(0.08, progress)})` }} />
        </div>
      </div>

      <div className="pointer-events-none absolute -bottom-20 -left-16 hidden h-[260px] w-[260px] lg:block" aria-hidden>
        <div className="h-full w-full animate-spin-slower rounded-full border-[3px] border-dashed border-gold/50 p-4">
          <div className={cn("relative h-full w-full overflow-hidden rounded-full")}>
            <Image src="/images/products/premium-cashews/lifestyle.webp" alt="" fill sizes="260px" className="object-cover" />
          </div>
        </div>
      </div>
      <div className="edge-dash absolute inset-x-0 bottom-0 [--c:theme(colors.cream.DEFAULT)]" aria-hidden />
    </section>
  );
}
