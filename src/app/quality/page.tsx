import type { Metadata } from "next";
import Image from "next/image";
import { site } from "@/config/site";
import { PageHeader } from "@/components/ui/PageHeader";
import { HexBadge } from "@/components/ui/Ornaments";
import { ButtonLink } from "@/components/ui/Button";
import { STAGES } from "@/data/process";
import { QualityPromise } from "@/components/home/Sections";

export const metadata: Metadata = {
  title: "Quality",
  description: "From source to shelf: the five-stage Velora Valley quality process — sourcing, processing, quality check, packaging and distribution.",
};

export default function QualityPage() {
  return (
    <>
      <PageHeader
        tone="forest"
        title="From source to shelf"
        script="Our quality process"
        crumbs={[{ label: "Quality" }]}
        intro="Every product you trust goes through a careful and well-monitored process to ensure consistent quality, taste and freshness."
      />

      <section className="container-site relative py-20 md:py-28" aria-label="Five stages">
        <div className="relative">
          {/* spine */}
          <div className="absolute bottom-0 left-[22px] top-0 w-[3px] rounded-full bg-forest/10 md:left-1/2 md:-translate-x-1/2" aria-hidden>
            <div data-draw className="h-full w-full rounded-full bg-gold" />
          </div>
          <ol className="space-y-16 md:space-y-24">
            {STAGES.map((s, i) => {
              const flip = i % 2 === 1;
              return (
                <li key={s.key} className="relative grid grid-cols-1 gap-6 pl-16 md:grid-cols-2 md:gap-28 md:pl-0">
                  <span
                    className="absolute left-0 top-0 z-10 flex h-12 w-12 items-center justify-center rounded-full border-[3px] border-cream bg-forest font-display text-[24px] font-bold text-gold-light md:left-1/2 md:top-1/2 md:h-16 md:w-16 md:-translate-x-1/2 md:-translate-y-1/2 md:text-[30px]"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <div className={flip ? "md:order-2" : ""} data-reveal={flip ? "right" : "left"}>
                    <div className="drop">
                      <div className="stamp" style={{ rotate: `${flip ? 2 : -2}deg` }}>
                        <div className="relative aspect-[4/3] overflow-hidden bg-dough">
                          <Image src={`/images/process/${s.key}.webp`} alt={`${s.title} — Velora Valley quality process`} fill sizes="(min-width: 768px) 45vw, 90vw" className="object-cover" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={`flex flex-col justify-center ${flip ? "md:order-1 md:items-end md:text-right" : ""}`} data-reveal="up">
                    <s.Icon width={30} className="text-leaf" />
                    <p className="serif-italic mt-3 text-[22px]">Stage {i + 1}</p>
                    <h2 className="text-display-sm">{s.title}</h2>
                    <p className="mt-3 max-w-[40ch] text-[14px] leading-relaxed text-forest/80">{s.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <QualityPromise />

      <section className="container-site pb-24 pt-4">
        <div className="mx-auto max-w-[720px]" data-reveal="scale">
          <HexBadge h={44} tone="sage" innerClassName="px-10 py-9 text-center sm:px-16">
            <p className="eyebrow text-forest/70">Food safety licence</p>
            <p className="display mt-2 text-[clamp(2rem,4.4vw,3.4rem)] leading-none">FSSAI {site.fssaiLicense}</p>
            <p className="mt-3 text-[12.5px] text-forest/75">
              Manufactured, processed and packed by {site.company}, {site.address.city}, {site.address.state}.
            </p>
          </HexBadge>
        </div>
        <div className="mt-12 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/shop" size="lg">
            Shop the range
          </ButtonLink>
          <ButtonLink href="/business" size="lg" variant="forest">
            Business enquiry
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
