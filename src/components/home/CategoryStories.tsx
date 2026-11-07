"use client";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import { categories } from "@/data/categories";
import { gsap, useGSAP, prefersReducedMotion } from "@/lib/gsap";
import { Frame } from "@/components/ui/Ornaments";
import { Roll } from "@/components/ui/Button";
import { IconArrowRight } from "@/components/ui/Icons";
import { cn } from "@/lib/format";

const TONE = { forest: "bg-forest", gold: "bg-gold", bark: "bg-bark", sage: "bg-sage-deep", butter: "bg-butter" } as const;

/**
 * Seven product categories told as an editorial sequence.
 * Desktop: pinned section scrolling horizontally. Mobile/tablet & reduced motion: vertical stack.
 */
export function CategoryStories({ counts }: { counts: Record<string, number> }) {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  // native horizontal scroll until (and unless) the pinned animation takes over
  const [pinned, setPinned] = useState(false);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const mm = gsap.matchMedia();
      mm.add("(min-width: 1024px)", () => {
        setPinned(true);
        const el = track.current!;
        const distance = () => el.scrollWidth - window.innerWidth;
        const tween = gsap.to(el, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: {
            trigger: root.current,
            start: "top top",
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 0.6,
            invalidateOnRefresh: true,
            anticipatePin: 1,
          },
        });
        // inner image drift + card float, tied to the horizontal tween
        gsap.utils.toArray<HTMLElement>("[data-story]").forEach((panel) => {
          const img = panel.querySelector("[data-story-img]");
          const card = panel.querySelector("[data-story-card]");
          gsap.fromTo(img, { xPercent: 8, scale: 1.12 }, { xPercent: -8, scale: 1.02, ease: "none", scrollTrigger: { trigger: panel, containerAnimation: tween, start: "left right", end: "right left", scrub: true } });
          gsap.fromTo(card, { y: 60, rotate: 3 }, { y: -30, rotate: -2, ease: "none", scrollTrigger: { trigger: panel, containerAnimation: tween, start: "left right", end: "right left", scrub: true } });
        });
        const bar = root.current!.querySelector("[data-story-progress]");
        gsap.fromTo(bar, { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { trigger: root.current, start: "top top", end: () => `+=${distance()}`, scrub: true } });
        return () => setPinned(false);
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} className={cn("relative bg-cream lg:h-screen", pinned ? "overflow-hidden" : "overflow-hidden lg:overflow-x-auto")} aria-labelledby="stories-title">
      <div ref={track} className="flex flex-col gap-16 py-20 lg:h-full lg:w-max lg:flex-row lg:items-center lg:gap-0 lg:py-0 lg:pl-10">
        {/* intro panel */}
        <div className="container-site lg:w-[38vw] lg:max-w-none lg:px-0 lg:pr-[4vw]">
          <p className="script -rotate-3 text-[32px] text-leaf" data-reveal="fade">
            Our range
          </p>
          <h2 id="stories-title" className="text-display-lg" data-split="words">
            Seven ways to taste the valley
          </h2>
          <p className="mt-5 max-w-[40ch] text-[14px] text-forest/80" data-reveal="up">
            From everyday dry fruits to festive gift boxes, here is everything Anantha Food Products makes, processes and packs under the Velora
            Valley name.
          </p>
          <p className="eyebrow mt-8 hidden items-center gap-3 text-forest/60 lg:flex">
            Scroll to explore <IconArrowRight width={16} className="animate-bob [animation-direction:alternate]" />
          </p>
        </div>

        {categories.map((c, i) => (
          <article key={c.slug} data-story className="container-site relative lg:h-[78vh] lg:w-[64vw] lg:max-w-[1000px] lg:px-0 lg:pr-[5vw]">
            <div className="relative h-full">
              <Link
                href={`/shop?category=${c.slug}`}
                className="group relative block aspect-[4/3] overflow-hidden rounded-[18px] bg-dough lg:aspect-auto lg:h-full lg:w-[78%]"
                aria-label={`Shop ${c.name}`}
              >
                <div data-story-img className="absolute inset-0">
                  <Image src={c.image} alt="" fill sizes="(min-width: 1024px) 50vw, 92vw" className="object-cover transition-transform duration-[1400ms] ease-out-expo group-hover:scale-105" />
                </div>
                <span className={cn("absolute left-4 top-4 rounded-full px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em]", TONE[c.accent], c.accent === "forest" || c.accent === "bark" ? "text-cream" : "text-forest-deep")}>
                  {String(i + 1).padStart(2, "0")} / {String(categories.length).padStart(2, "0")}
                </span>
              </Link>
              {c.cutout && (
                <Image
                  src={c.cutout}
                  alt=""
                  width={400}
                  height={540}
                  sizes="220px"
                  className="pointer-events-none absolute -top-6 right-[16%] hidden w-[180px] rotate-6 drop-shadow-[0_24px_22px_rgba(18,30,10,.4)] lg:block xl:w-[210px]"
                />
              )}
              <div data-story-card className="relative z-10 -mt-16 ml-auto w-[88%] max-w-[380px] sm:-mt-24 lg:absolute lg:bottom-[6%] lg:right-0 lg:mt-0 lg:w-[360px]">
                <Frame tone={i % 2 ? "sage" : "light"} n={18} innerClassName="p-6">
                  <p className="eyebrow text-leaf">{counts[c.slug] ?? 0} products</p>
                  <h3 className="mt-2 text-[clamp(2.2rem,3.6vw,3.4rem)] leading-[0.88]">{c.name}</h3>
                  <p className="mt-3 text-[13px] leading-relaxed text-forest/80">{c.blurb}</p>
                  <Link href={`/shop?category=${c.slug}`} className="btn btn-forest btn-sm mt-5">
                    <Roll>{`Shop ${c.short.toLowerCase()}`}</Roll>
                    <IconArrowRight width={16} />
                  </Link>
                </Frame>
              </div>
            </div>
          </article>
        ))}
        <div className="hidden w-[6vw] shrink-0 lg:block" aria-hidden />
      </div>
      <div className="absolute inset-x-10 bottom-8 hidden h-[3px] overflow-hidden rounded-full bg-forest/10 lg:block" aria-hidden>
        <div data-story-progress className="h-full origin-left bg-forest" />
      </div>
    </section>
  );
}
