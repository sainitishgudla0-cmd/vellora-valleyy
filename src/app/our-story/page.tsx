import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { site } from "@/config/site";
import { categories } from "@/data/categories";
import { getCategoryCounts, getProducts } from "@/lib/catalog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Frame, OctBadge, Polaroid } from "@/components/ui/Ornaments";
import { ButtonLink } from "@/components/ui/Button";
import { IconArrowRight } from "@/components/ui/Icons";
import { Ribbons } from "@/components/home/Sections";

export const metadata: Metadata = {
  title: "Our Story",
  description: `Velora Valley is the brand of ${site.company}, Anantapur — manufacturers, processors and packers of dry fruits, dates, seeds and more.`,
};
export const revalidate = 60;

export default async function OurStoryPage() {
  const [all, counts] = await Promise.all([getProducts(), getCategoryCounts()]);
  const variants = all.reduce((n, p) => n + p.variants.length, 0);

  return (
    <>
      <PageHeader
        tone="forest"
        title="Our story"
        script="Velora Valley by Anantha Food Products"
        crumbs={[{ label: "Our Story" }]}
        intro="A brand from Anantapur, Andhra Pradesh, bringing premium dry fruits, dates, seeds and everyday foods from the valley to your table."
      />

      {/* who we are */}
      <section className="container-site grid grid-cols-1 gap-14 py-20 md:py-28 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="script -rotate-2 text-[32px] text-leaf" data-reveal="fade">
            Who we are
          </p>
          <h2 className="text-display-md" data-split="words">
            Makers, processors &amp; packers
          </h2>
          <div className="mt-6 max-w-[56ch] space-y-4 text-[14px] leading-relaxed text-forest/85" data-reveal="up">
            <p>{site.company} is the company behind Velora Valley. {site.manufacturerLine.charAt(0).toUpperCase() + site.manufacturerLine.slice(1)}</p>
            <p>
              Our products are made for modern retail, bulk supply and distribution across India — and for families who want dependable,
              good-quality staples at home.
            </p>
            <p>
              Every product goes through our five-stage process — sourcing, processing, quality check, packaging and distribution — so that what
              reaches you is consistent in quality, taste and freshness.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap gap-3" data-reveal="up">
            <ButtonLink href="/quality">Our quality process</ButtonLink>
            <ButtonLink href="/shop" variant="forest">
              Shop the range
            </ButtonLink>
          </div>
        </div>
        <div className="relative mx-auto h-[520px] w-full max-w-[560px]" aria-hidden>
          <div className="absolute left-0 top-0 w-[52%]" data-reveal="drop">
            <Polaroid src="/images/process/sourcing.webp" alt="" tilt={-6} ratio="4/5" sizes="300px" caption="Sourcing" />
          </div>
          <div className="absolute right-0 top-[10%] w-[50%]" data-reveal="drop" data-delay="0.1">
            <Polaroid src="/images/process/processing.webp" alt="" tilt={5} ratio="1/1" sizes="280px" caption="Processing" />
          </div>
          <div className="absolute bottom-0 left-[24%] w-[48%]" data-reveal="drop" data-delay="0.2">
            <Polaroid src="/images/process/packaging.webp" alt="" tilt={-2} ratio="5/4" sizes="280px" caption="Packaging" />
          </div>
          <div className="absolute bottom-[8%] right-0 w-[28%]" data-reveal="scale" data-delay="0.3">
            <OctBadge value={all.length} label="Products" tone="forest" />
          </div>
        </div>
      </section>

      <Ribbons />

      {/* what we make */}
      <section className="container-site py-20 md:py-28" aria-labelledby="make-title">
        <div className="mb-12 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="script -rotate-2 text-[32px] text-leaf">What we make</p>
            <h2 id="make-title" className="text-display-md" data-split="words">
              Seven categories, one valley
            </h2>
          </div>
          <p className="max-w-[36ch] text-[13.5px] text-forest/75">
            {all.length} products in {variants} pack sizes, from pocket pouches to family packs and gift boxes.
          </p>
        </div>
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {categories.map((c, i) => (
            <li key={c.slug} data-reveal="up" className={i === 0 ? "sm:col-span-2 lg:row-span-2" : ""}>
              <Link href={`/shop?category=${c.slug}`} className="group relative block h-full min-h-[260px] overflow-hidden rounded-[16px] bg-dough">
                <Image src={c.image} alt="" fill sizes={i === 0 ? "(min-width: 1024px) 50vw, 100vw" : "(min-width: 1024px) 25vw, 50vw"} className="object-cover transition-transform duration-[1200ms] ease-out-expo group-hover:scale-110" />
                <div className="absolute inset-0 bg-gradient-to-t from-forest-deep/85 via-forest-deep/10 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-5 text-cream">
                  <p className="eyebrow text-gold-light">{counts[c.slug] ?? 0} products</p>
                  <h3 className={i === 0 ? "text-display-sm" : "text-[30px] leading-[0.9]"}>{c.name}</h3>
                  <span className="mt-3 flex items-center gap-2 text-[12.5px] opacity-0 transition-all duration-500 group-hover:opacity-100 max-lg:opacity-100">
                    Explore <IconArrowRight width={16} className="transition-transform group-hover:translate-x-1" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* where we are */}
      <section className="container-site pb-24">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center" data-reveal="up">
          <Frame tone="sage" n={22} innerClassName="p-7 sm:p-10">
            <p className="script text-[30px] text-leaf">Where we are</p>
            <h2 className="text-display-sm">Anantapur, Andhra Pradesh</h2>
            <address className="mt-5 text-[14px] not-italic leading-relaxed">
              {site.company}
              <br />
              {site.address.line1}, {site.address.city}
              <br />
              {site.address.state} {site.address.pincode}, {site.address.country}
            </address>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink href="/contact">Contact us</ButtonLink>
              <ButtonLink href="/business" variant="forest">
                Partner with us
              </ButtonLink>
            </div>
          </Frame>
          <div className="relative aspect-[16/10] overflow-hidden rounded-[18px]">
            <div className="absolute inset-x-0 -bottom-[10%] -top-[10%]" data-parallax="0.08">
              <Image src="/images/brand/valley-wide.webp" alt="Illustrated Velora Valley landscape" fill sizes="(min-width: 1024px) 55vw, 100vw" className="object-cover" />
            </div>
            <Image src="/images/brand/logo-forest.png" alt="" width={555} height={247} className="absolute left-1/2 top-[14%] w-[34%] -translate-x-1/2" />
          </div>
        </div>
      </section>
    </>
  );
}
