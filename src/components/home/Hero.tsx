"use client";
import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";
import { gsap, ScrollTrigger, SplitText, useGSAP, prefersReducedMotion } from "@/lib/gsap";
import { Frame, HexBadge, Polaroid } from "@/components/ui/Ornaments";
import { Roll } from "@/components/ui/Button";
import { IconArrowDown, IconArrowRight } from "@/components/ui/Icons";
import { getLenis } from "@/components/motion/SmoothScroll";

const PACKS = [
  { slug: "arabian-seeded-dates", alt: "Arabian Seeded Dates 1kg pouch", l: 6, b: 20, w: 16.5, r: -11, d: 0.5, z: 1 },
  { slug: "california-almonds", alt: "California Almonds pouch", l: 20, b: 11, w: 18.5, r: -5, d: 0.85, z: 2 },
  { slug: "premium-cashews", alt: "Premium Cashews pouch", l: 39.5, b: 5, w: 21, r: 0, d: 1.2, z: 4 },
  { slug: "salted-roasted-pistachios", alt: "Salted and Roasted Pistachios pouch", l: 59.5, b: 11, w: 18.5, r: 6, d: 0.85, z: 3 },
  { slug: "premium-black-raisins", alt: "Premium Black Raisins pouch", l: 76.5, b: 20, w: 16.5, r: 11, d: 0.5, z: 1 },
  { slug: "kimia-dates", alt: "Kimia Dates tub", l: 8, b: -14, w: 27, r: -4, d: 1.5, z: 5 },
  { slug: "safawi-dates", alt: "Safawi Dates gift box", l: 64, b: -16, w: 27, r: 5, d: 1.5, z: 5 },
];

export function Hero() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const reduced = prefersReducedMotion();
      const headline = q("[data-hero-headline]")[0] as HTMLElement;
      if (reduced) {
        gsap.set(q("[data-hero-anim]"), { opacity: 1 });
        gsap.set(q("[data-hero-panel]"), { clipPath: "none" });
        if (headline) headline.style.visibility = "visible";
        return;
      }
      const delay = (window as unknown as { __vvIntro?: boolean }).__vvIntro ? 0.95 : 0.1;
      const split = SplitText.create(headline, { type: "lines,words", mask: "lines" });
      headline.style.visibility = "visible";

      const tl = gsap.timeline({ delay, defaults: { ease: "expo.out" } });
      tl.fromTo(q("[data-hero-panel]"), { clipPath: "inset(6% 4% 6% 4% round 28px)" }, { clipPath: "inset(0% 0% 0% 0% round 18px)", duration: 1.5, ease: "expo.inOut" }, 0)
        .fromTo(q("[data-hero-bg]"), { scale: 1.25 }, { scale: 1, duration: 2.2 }, 0)
        .fromTo(q("[data-pack]"), { yPercent: 70, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1.4, stagger: { each: 0.07, from: "center" }, ease: "back.out(1.4)" }, 0.45)
        .fromTo(q("[data-hero-badge]"), { scale: 0.86, rotate: -3, opacity: 0, y: 40 }, { scale: 1, rotate: 0, opacity: 1, y: 0, duration: 1.2 }, 0.7)
        .from(split.words, { yPercent: 115, rotate: 4, duration: 1.1, stagger: 0.05 }, 0.85)
        .fromTo(q("[data-hero-pol]"), { y: -60, rotate: -12, opacity: 0 }, { y: 0, rotate: 0, opacity: 1, duration: 1.3, stagger: 0.12, ease: "back.out(1.2)" }, 0.9)
        .fromTo(q("[data-hero-card]"), { x: 60, opacity: 0 }, { x: 0, opacity: 1, duration: 1.2 }, 1.0)
        .fromTo(q("[data-hero-plate]"), { scale: 0.4, rotate: -90, opacity: 0 }, { scale: 1, rotate: 0, opacity: 1, duration: 1.5 }, 1.05)
        .fromTo(q("[data-hero-in]"), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.9, stagger: 0.08 }, 1.2);

      // scroll depth
      const st = { trigger: root.current, start: "top top", end: "bottom top", scrub: true };
      gsap.to(q("[data-hero-bg]"), { yPercent: 12, ease: "none", scrollTrigger: st });
      q("[data-pack]").forEach((el) => {
        const d = Number((el as HTMLElement).dataset.depth);
        gsap.to(el, { y: -90 * d, ease: "none", scrollTrigger: st });
      });
      gsap.to(q("[data-hero-pol-wrap]"), { y: -70, ease: "none", scrollTrigger: st });

      // pointer parallax (fine pointers only)
      if (window.matchMedia("(pointer: fine)").matches) {
        const movers = q("[data-pack-inner]").map((el) => ({
          x: gsap.quickTo(el, "x", { duration: 1.2, ease: "power3.out" }),
          y: gsap.quickTo(el, "y", { duration: 1.2, ease: "power3.out" }),
          d: Number((el as HTMLElement).dataset.depth),
        }));
        const onMove = (e: PointerEvent) => {
          const nx = e.clientX / window.innerWidth - 0.5;
          const ny = e.clientY / window.innerHeight - 0.5;
          movers.forEach((m) => {
            m.x(nx * 26 * m.d);
            m.y(ny * 14 * m.d);
          });
        };
        window.addEventListener("pointermove", onMove);
        return () => {
          window.removeEventListener("pointermove", onMove);
          split.revert();
        };
      }
      ScrollTrigger.refresh();
      return () => split.revert();
    },
    { scope: root },
  );

  const scrollDown = () => {
    const next = root.current?.nextElementSibling as HTMLElement | null;
    if (!next) return;
    const l = getLenis();
    l ? l.scrollTo(next, { offset: -90 }) : next.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section ref={root} className="relative px-3 pb-6 pt-3 sm:px-4 lg:px-6 lg:pb-[150px]" aria-labelledby="hero-title">
      <div className="relative mx-auto max-w-site">
        {/* ── image panel */}
        <div data-hero-panel className="relative h-[64svh] min-h-[430px] overflow-hidden rounded-[18px] bg-forest sm:h-[70svh] lg:h-[min(calc(100svh-140px),820px)] lg:min-h-[640px]">
          <div data-hero-bg className="absolute inset-x-0 -bottom-[6%] -top-[14%] origin-bottom">
            <Image src="/images/brand/valley-wide.webp" alt="" fill priority sizes="100vw" className="object-cover object-[50%_20%]" />
          </div>
          {/* sky glow */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgba(255,226,120,.85),rgba(255,214,90,.35)_45%,transparent_75%)]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-forest-deep/40 to-transparent" />

          {/* stat chips */}
          <div className="absolute left-4 top-4 flex flex-wrap gap-2 sm:left-6 sm:top-6">
            <span data-hero-in data-hero-anim className="eyebrow rounded-full bg-cream-light/90 px-3 py-1.5 text-[10px] backdrop-blur">30 products · 40 pack sizes</span>
            <span data-hero-in data-hero-anim className="eyebrow hidden rounded-full bg-forest/85 px-3 py-1.5 text-[10px] text-cream backdrop-blur sm:inline-block">
              Anantapur, Andhra Pradesh
            </span>
          </div>

          {/* packshot cluster */}
          <div className="absolute bottom-[34%] left-1/2 aspect-[980/520] w-[118%] -translate-x-1/2 sm:bottom-[30%] sm:w-[92%] lg:bottom-[31%] lg:w-[min(900px,62%)]">
            {PACKS.map((p, i) => (
              <div
                key={p.slug}
                data-pack
                data-hero-anim
                data-depth={p.d}
                className="absolute"
                style={{ left: `${p.l}%`, bottom: `${p.b}%`, width: `${p.w}%`, zIndex: p.z }}
              >
                <div data-pack-inner data-depth={p.d}>
                  <Image
                    src={`/images/products/${p.slug}/cutout.webp`}
                    alt={p.alt}
                    width={600}
                    height={800}
                    priority={i < 5}
                    sizes="(min-width: 1024px) 220px, 26vw"
                    className="h-auto w-full drop-shadow-[0_22px_18px_rgba(18,30,10,.45)]"
                    style={{ rotate: `${p.r}deg` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── polaroids (desktop) */}
        <div data-hero-pol-wrap className="pointer-events-none absolute -left-2 top-[7%] z-10 hidden w-[210px] lg:block xl:-left-4 xl:w-[230px]">
          <div data-hero-pol data-hero-anim className="pointer-events-auto">
            <Polaroid src="/images/products/premium-cashews/lifestyle.webp" alt="Velora Valley Premium Cashews" tilt={-6} sizes="250px" ratio="1/1" />
          </div>
          <div data-hero-pol data-hero-anim className="pointer-events-auto relative -mt-12 ml-[34%] w-[180px]">
            <Polaroid src="/images/products/premium-black-raisins/lifestyle.webp" alt="Velora Valley Premium Black Raisins" tilt={5} sizes="200px" ratio="1/1" />
          </div>
          <p data-hero-in data-hero-anim className="script absolute -bottom-16 left-2 w-[220px] -rotate-[8deg] text-[34px] leading-[0.85] text-cream drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]">
            Handpicked from the valley
          </p>
        </div>

        {/* ── rotating plate (desktop) */}
        <div data-hero-plate data-hero-anim className="absolute bottom-[-96px] left-[2%] z-10 hidden h-[180px] w-[180px] lg:block xl:h-[210px] xl:w-[210px]">
          <div className="h-full w-full animate-spin-slower rounded-full bg-forest p-[10px] shadow-lift">
            <div className="h-full w-full rounded-full border-[3px] border-dashed border-gold-light p-[6px]">
              <div className="relative h-full w-full overflow-hidden rounded-full">
                <Image src="/images/products/safawi-dates/lifestyle.webp" alt="" fill sizes="220px" className="scale-125 object-cover object-[60%_70%]" />
              </div>
            </div>
          </div>
        </div>

        {/* ── headline badge */}
        <div className="relative z-20 mx-auto -mt-[92px] w-[min(100%,560px)] sm:-mt-[120px] lg:absolute lg:bottom-[-118px] lg:left-1/2 lg:mt-0 lg:w-[min(760px,56%)] lg:-translate-x-1/2">
          <div data-hero-badge data-hero-anim>
          <HexBadge h={52} tone="light" innerClassName="px-12 py-6 text-center sm:px-16 lg:px-20 lg:py-8">
            <p data-hero-in data-hero-anim className="eyebrow flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[10px] text-forest/75">
              <span>Velora Valley</span>
              <span className="h-1 w-1 rotate-45 bg-gold" />
              <span>by Anantha Food Products</span>
            </p>
            <h1 id="hero-title" data-hero-headline className="mt-2 text-[clamp(2.5rem,6.4vw,5.6rem)] leading-[0.86] text-forest">
              Nature&apos;s finest. Delivered to your table.
            </h1>
            <p data-hero-in data-hero-anim className="mt-3 text-[12px] text-forest/75">
              Dry fruits · Nuts · Dates · Seeds
            </p>
          </HexBadge>
          </div>
        </div>

        {/* ── info card */}
        <div data-hero-card data-hero-anim className="relative z-20 mx-auto mt-5 w-[min(100%,560px)] lg:absolute lg:-bottom-[78px] lg:right-[1.5%] lg:mt-0 lg:w-[310px] xl:right-[2.5%] xl:w-[330px]">
          <Frame tone="sage" n={18} innerClassName="p-5 sm:p-6">
            <p className="text-[13.5px] leading-relaxed">
              Discover the goodness of premium dry fruits, handpicked nuts, wholesome seeds and naturally delicious treats.
            </p>
            <Link href="/shop" className="btn mt-4 w-full">
              <Roll>Explore our products</Roll>
              <IconArrowRight width={18} />
            </Link>
            <Link href="/shop?category=dates" className="group mt-3 flex items-center justify-center gap-1.5 text-[12.5px]">
              <span className="link-underline">or shop our dates collection</span>
            </Link>
          </Frame>
        </div>

        {/* ── scroll cue */}
        <button
          onClick={scrollDown}
          aria-label="Scroll to next section"
          className="absolute bottom-[-104px] right-[calc(50%-min(380px,28%)-70px)] z-20 hidden h-12 w-12 items-center justify-center rounded-full border-[1.5px] border-forest bg-cream-light transition-colors hover:bg-gold lg:flex xl:right-[calc(50%-min(380px,28%)-78px)]"
        >
          <IconArrowDown width={18} className="animate-bob" />
        </button>
      </div>
    </section>
  );
}
