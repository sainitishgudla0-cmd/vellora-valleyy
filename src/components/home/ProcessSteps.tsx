"use client";
import Image from "next/image";
import { useRef } from "react";
import { gsap, useGSAP, prefersReducedMotion } from "@/lib/gsap";
import { Frame } from "@/components/ui/Ornaments";
import { STAGES } from "@/data/process";


const TILT = [-4, 2.5, -1.5, 3, -2.5];
const LIFT = [10, -14, 6, -8, 14];

export function ProcessSteps() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const mm = gsap.matchMedia();
      mm.add("(min-width: 1024px)", () => {
        const cards = gsap.utils.toArray<HTMLElement>("[data-step]");
        const row = root.current!.querySelector<HTMLElement>("[data-steps-row]")!;
        const tl = gsap.timeline({
          scrollTrigger: { trigger: root.current, start: "top top", end: "+=110%", pin: true, scrub: 0.7, anticipatePin: 1 },
        });
        tl.from(cards, {
          x: (i, el: HTMLElement) => {
            const r = row.getBoundingClientRect();
            const c = el.getBoundingClientRect();
            return r.left + r.width / 2 - (c.left + c.width / 2);
          },
          y: 120,
          rotate: (i) => [-14, 9, -4, 12, -8][i],
          scale: 0.86,
          ease: "power2.out",
          stagger: 0.04,
          duration: 1,
        })
          .from("[data-step-num]", { scale: 0, rotate: -90, stagger: 0.05, duration: 0.4, ease: "back.out(2)" }, 0.55)
          .to("[data-plate]", { rotate: 160, ease: "none", duration: 1.2 }, 0);
      });
      mm.add("(max-width: 1023px)", () => {
        gsap.utils.toArray<HTMLElement>("[data-step]").forEach((el, i) => {
          gsap.from(el, { y: 60, rotate: TILT[i] * 2, opacity: 0, duration: 1, scrollTrigger: { trigger: el, start: "top 88%", once: true } });
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} className="grain relative overflow-hidden bg-bark text-cream lg:flex lg:h-screen lg:flex-col lg:justify-center" aria-labelledby="process-title">
      <div className="edge-dash absolute inset-x-0 top-0 [--c:theme(colors.cream.DEFAULT)]" aria-hidden />

      {/* peeking plates */}
      <div data-plate className="pointer-events-none absolute -top-[130px] left-1/2 h-[260px] w-[260px] -translate-x-1/2 md:-top-[170px] md:h-[340px] md:w-[340px]" aria-hidden>
        <div className="h-full w-full rounded-full bg-bark-deep p-3">
          <div className="h-full w-full rounded-full border-[6px] border-dashed border-gold-light/80 p-2">
            <div className="relative h-full w-full overflow-hidden rounded-full">
              <Image src="/images/products/arabian-premium-seedless-dates/lifestyle.webp" alt="" fill sizes="340px" className="object-cover" />
            </div>
          </div>
        </div>
      </div>

      <div className="container-site relative pb-20 pt-[170px] md:pt-[220px] lg:py-0">
        <div className="mb-10 flex flex-col items-start justify-between gap-4 md:flex-row md:items-end lg:mb-14">
          <div>
            <p className="eyebrow text-gold-light">Our quality process</p>
            <h2 id="process-title" className="mt-2 text-display-lg" data-split="words">
              From source to shelf
            </h2>
          </div>
          <p className="max-w-[40ch] text-[13.5px] text-cream/80">
            Every product you trust goes through a careful and well-monitored process to ensure consistent quality, taste and freshness.
          </p>
        </div>

        <ol data-steps-row className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5 lg:gap-3 xl:gap-4">
          {STAGES.map((s, i) => (
            <li key={s.key} data-step className="relative" style={{ zIndex: 5 - Math.abs(2 - i) }}>
              <div style={{ rotate: `${TILT[i]}deg`, translate: `0 ${LIFT[i]}px` }} className="transition-[rotate,translate] duration-700 ease-out-expo hover:![rotate:0deg] hover:![translate:0_-8px]">
                <Frame tone="sage" n={16} gap={5} innerClassName="flex flex-col text-forest">
                  <div className="relative aspect-[4/3] overflow-hidden">
                    <Image src={`/images/process/${s.key}.webp`} alt={`${s.title} at Velora Valley`} fill sizes="(min-width: 1024px) 18vw, 45vw" className="object-cover" />
                    <span
                      data-step-num
                      className="absolute left-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-forest font-display text-[22px] font-bold text-gold-light"
                    >
                      {i + 1}
                    </span>
                  </div>
                  <div className="p-4 text-center xl:p-5">
                    <s.Icon width={22} className="mx-auto text-leaf" />
                    <p className="serif-italic mt-2 text-[17px]">Stage {i + 1}</p>
                    <h3 className="text-[clamp(1.6rem,2.1vw,2.1rem)] leading-none">{s.title}</h3>
                    <p className="mt-2 text-[12px] leading-relaxed text-forest/80">{s.text}</p>
                  </div>
                </Frame>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="edge-dash absolute inset-x-0 bottom-0 [--c:theme(colors.cream.DEFAULT)]" aria-hidden />
    </section>
  );
}
