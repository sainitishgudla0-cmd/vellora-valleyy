import Image from "next/image";
import Link from "next/link";
import { categories } from "@/data/categories";
import { site, testimonials } from "@/config/site";
import { BUSINESS_INTERESTS } from "@/lib/validation";
import { CircleText, Frame, HexBadge, Marquee, OctBadge, Polaroid, Stars } from "@/components/ui/Ornaments";
import { ButtonLink } from "@/components/ui/Button";
import {
  IconArrowRight,
  IconBox,
  IconCheck,
  IconCloche,
  IconFactory,
  IconGlobe,
  IconHandshake,
  IconLeaf,
  IconShield,
  IconStore,
  IconTruck,
  IconBadge,
} from "@/components/ui/Icons";

/* ───────────────────────── Category ticker ───────────────────────── */
export function CategoryTicker() {
  return (
    <section aria-label="Product categories" className="pb-4 pt-10 lg:pt-14">
      <p className="mb-5 text-center text-[12px] text-forest/70">Seven ways to taste the valley:</p>
      <Marquee speed={55}>
        {categories.map((c) => (
          <Link
            key={c.slug}
            href={`/shop?category=${c.slug}`}
            className="tile-notch group mx-1.5 flex h-[86px] w-[250px] items-center gap-3 bg-dough px-6 transition-colors duration-500 hover:bg-sage"
          >
            <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full">
              <Image src={c.image} alt="" fill sizes="56px" className="object-cover transition-transform duration-700 group-hover:scale-125" />
            </span>
            <span className="display text-[22px] leading-[0.9]">{c.name}</span>
          </Link>
        ))}
      </Marquee>
    </section>
  );
}

/* ───────────────────────── Brand intro ("Namaste!") ───────────────────────── */
export function BrandIntro({ productCount, variantCount }: { productCount: number; variantCount: number }) {
  return (
    <section className="container-site relative py-20 md:py-28" aria-labelledby="intro-title">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,560px)_1fr] lg:gap-6">
        <div data-reveal="up" className="relative z-10">
          <Frame tone="sage" n={26} innerClassName="px-6 py-10 text-center sm:px-10 sm:py-12">
            <h2 id="intro-title" className="text-display-md" data-split="chars">
              Namaste!
            </h2>
            <div className="mx-auto mt-6 max-w-[46ch] space-y-4 text-[13.5px] leading-relaxed text-forest/90">
              <p>
                Velora Valley is the brand of <strong className="font-medium">{site.company}</strong>, based in Anantapur, Andhra Pradesh. We are
                manufacturers, processors and packers of dry fruits, all types of dates and seeds, ready-to-cook foods like chapati and parota,
                ragi malt, jams, tutti frutti, candied karonda cherry, mixed jellies, biscuits and chocolates.
              </p>
              <p>
                Every product you trust goes through a careful and well-monitored process — from sourcing to packaging — to ensure consistent
                quality, taste and freshness.
              </p>
              <p>Bring the valley home, or partner with us for retail, bulk supply and distribution across India.</p>
            </div>
            <p className="mt-6 text-[11px] uppercase tracking-[0.18em] text-forest/60">With care,</p>
            <p className="script text-[38px] text-leaf">Team Anantha Food Products</p>
          </Frame>
        </div>

        {/* collage */}
        <div className="relative mx-auto h-[520px] w-full max-w-[640px] sm:h-[600px] lg:-ml-8 lg:max-w-none" aria-hidden>
          <div className="absolute left-[2%] top-[6%] w-[44%] max-w-[260px]" data-reveal="drop">
            <Polaroid src="/images/process/processing.webp" alt="" tilt={-6} ratio="4/5" sizes="260px" />
          </div>
          <div className="absolute right-[4%] top-0 w-[42%] max-w-[250px]" data-reveal="drop" data-delay="0.1">
            <Polaroid src="/images/process/packaging.webp" alt="" tilt={5} ratio="1/1" sizes="250px" />
          </div>
          <div className="absolute bottom-[3%] right-[10%] w-[46%] max-w-[280px]" data-reveal="drop" data-delay="0.2">
            <Polaroid src="/images/products/arabian-seeded-dates/lifestyle.webp" alt="" tilt={-3} ratio="4/5" sizes="280px" caption="Sweet by nature" />
          </div>
          <div className="absolute bottom-[14%] left-[8%] w-[36%] max-w-[210px]" data-reveal="scale" data-delay="0.15">
            <OctBadge value={productCount} label="Products" tone="forest" />
          </div>
          <div className="absolute left-[38%] top-[34%] w-[30%] max-w-[190px]" data-reveal="scale" data-delay="0.25">
            <OctBadge value={variantCount} label="Pack sizes" tone="bark" />
          </div>
          <p className="script absolute bottom-0 left-[4%] -rotate-6 text-[34px] text-leaf" data-reveal="fade">
            From source to shelf!
          </p>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Ribbons ───────────────────────── */
function RibbonRow({ words }: { words: string[] }) {
  return (
    <>
      {words.map((w) => (
        <span key={w} className="flex items-center">
          <span className="display px-6 text-[clamp(2.4rem,6vw,5.5rem)] leading-none">{w}</span>
          <svg viewBox="0 0 24 24" className="h-8 w-8 fill-current opacity-80 md:h-10 md:w-10" aria-hidden>
            <path d="M12 2c.6 4.6 2.4 7.4 10 10-7.6 2.6-9.4 5.4-10 10-.6-4.6-2.4-7.4-10-10 7.6-2.6 9.4-5.4 10-10z" />
          </svg>
        </span>
      ))}
    </>
  );
}

export function Ribbons() {
  return (
    <section aria-hidden className="relative z-10 -my-6 overflow-hidden py-16 md:py-24">
      <div className="-mx-10 -rotate-[2.5deg] border-y-[2px] border-forest bg-sage py-3 text-forest md:py-4">
        <Marquee speed={45}>
          <RibbonRow words={["Premium dry fruits", "Handpicked nuts", "Wholesome seeds", "Ready to cook"]} />
        </Marquee>
      </div>
      <div className="-mx-10 mt-[-10px] rotate-[1.8deg] border-y-[2px] border-forest bg-gold py-3 text-forest-deep md:py-4">
        <Marquee speed={50} reverse>
          <RibbonRow words={["Safawi", "Kimia", "Arabian dates", "Seedless dates"]} />
        </Marquee>
      </div>
    </section>
  );
}

/* ───────────────────────── Testimonials ───────────────────────── */
export function Testimonials() {
  const has = testimonials.length > 0;
  return (
    <section className="container-site relative py-20 md:py-28" aria-labelledby="reviews-title">
      <div className="mb-12 flex flex-col items-center text-center">
        <p className="script -rotate-3 text-[32px] text-leaf" data-reveal="fade">
          Kind words
        </p>
        <h2 id="reviews-title" className="text-display-lg" data-split="words">
          From our customers
        </h2>
      </div>
      {has ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {testimonials.map((t, i) => (
            <div key={i} data-reveal="up" className={i % 2 ? "lg:mt-8" : ""}>
              <Frame tone="dough" n={14} innerClassName="flex h-full flex-col items-center p-6 text-center">
                {t.rating && <Stars n={t.rating} className="text-forest" />}
                <blockquote className="serif-italic mt-3 flex-1 text-[19px] leading-snug">&ldquo;{t.quote}&rdquo;</blockquote>
                <p className="mt-4 text-[12px] text-forest/60">
                  {t.name}
                  {t.context && ` — ${t.context}`}
                </p>
              </Frame>
            </div>
          ))}
        </div>
      ) : (
        <div className="relative">
          {/* placeholder layout, ready to be populated from src/config/site.ts */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} data-reveal="up" className={i % 2 ? "lg:mt-8" : ""}>
                <Frame tone="dough" n={14} innerClassName="flex h-[230px] flex-col items-center justify-center gap-2.5 p-6">
                  <Stars n={0} className="text-forest/40" />
                  {[88, 72, 80, 54].map((w, j) => (
                    <span key={j} className="h-2.5 rounded-full bg-forest/10" style={{ width: `${w - i * 3}%` }} />
                  ))}
                  <span className="mt-3 h-2 w-1/3 rounded-full bg-forest/10" />
                </Frame>
              </div>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto w-full max-w-[520px]" data-reveal="scale">
              <HexBadge h={40} tone="light" innerClassName="px-10 py-7 text-center sm:px-14">
                <p className="serif-italic text-[22px] leading-tight sm:text-[26px]">We&apos;re collecting our first reviews.</p>
                <p className="mt-2 text-[12.5px] text-forest/75">Tried Velora Valley? We would love to hear what you think.</p>
                <Link href="/contact?topic=feedback" className="btn btn-sm mt-4">
                  Share your feedback
                </Link>
              </HexBadge>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── Quality promise ───────────────────────── */
const PROMISES = [
  { title: "Carefully selected ingredients", text: "Raw materials from carefully selected farms and trusted suppliers.", Icon: IconLeaf },
  { title: "Quality-controlled processing", text: "Clean, modern facilities with standardised processing to retain taste and goodness.", Icon: IconFactory },
  { title: "Multi-level quality checks", text: "Checks at multiple levels to ensure consistency, safety and freshness.", Icon: IconShield },
  { title: "Hygienic, sealed packaging", text: "Hygienic, sealed packaging to lock in freshness and ensure safety.", Icon: IconBox },
  { title: "Consistent quality", text: "A careful, well-monitored process for consistent quality, taste and freshness.", Icon: IconBadge },
  { title: "Distribution across India", text: "Bulk supply capability and timely delivery across India, with care and commitment.", Icon: IconTruck },
];

export function QualityPromise() {
  return (
    <section className="container-site relative py-16 md:py-24" aria-labelledby="promise-title">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[1fr_minmax(0,600px)] lg:gap-10">
        <div className="relative mx-auto h-[460px] w-full max-w-[560px] sm:h-[540px]" aria-hidden>
          <div className="absolute left-[4%] top-[2%] w-[52%]" data-reveal="drop">
            <Polaroid src="/images/process/quality.webp" alt="" tilt={-5} ratio="4/5" sizes="300px" />
          </div>
          <div className="absolute right-[2%] top-[14%] w-[48%]" data-reveal="drop" data-delay="0.1">
            <Polaroid src="/images/process/sourcing.webp" alt="" tilt={6} ratio="1/1" sizes="280px" />
          </div>
          <div className="absolute bottom-[2%] left-[20%] w-[56%]" data-reveal="drop" data-delay="0.2">
            <Polaroid src="/images/products/roasted-super-seed-mix/lifestyle.webp" alt="" tilt={-1.5} ratio="5/4" sizes="320px" />
          </div>
          <p className="script absolute -right-2 bottom-[12%] hidden rotate-[-8deg] text-[32px] text-leaf sm:block">Freshness, sealed in.</p>
        </div>

        <div data-reveal="up">
          <Frame tone="light" n={24} innerClassName="px-6 py-10 sm:px-10">
            <h2 id="promise-title" className="text-center text-display-sm" data-split="words">
              Our promise
            </h2>
            <ul className="mt-8 space-y-0">
              {PROMISES.map(({ title, text, Icon }) => (
                <li key={title} className="group border-b-[1.5px] border-forest/20 py-3.5 first:pt-0">
                  <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-forest text-cream transition-transform duration-500 ease-out-expo group-hover:rotate-[-12deg] group-hover:scale-110">
                      <IconCheck width={14} />
                    </span>
                    <h3 className="font-mono text-[14px] font-medium normal-case tracking-normal" style={{ fontVariationSettings: "normal" }}>
                      {title}
                    </h3>
                    <Icon width={18} className="ml-auto shrink-0 text-forest/40 transition-colors group-hover:text-leaf" />
                  </div>
                  <p className="mt-1.5 pl-10 text-[12.5px] leading-relaxed text-forest/70">{text}</p>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-center text-[11px] text-forest/60">FSSAI Lic. No. {site.fssaiLicense}</p>
            <div className="mt-5 flex justify-center">
              <ButtonLink href="/quality">See our quality process</ButtonLink>
            </div>
          </Frame>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Dates & Nuts circle ───────────────────────── */
export function DatesNutsCircle() {
  return (
    <section className="relative overflow-hidden py-20 md:py-28" aria-labelledby="circle-title">
      <h2 id="circle-title" className="sr-only">
        Dates and nuts
      </h2>
      <div className="relative mx-auto aspect-square w-[min(94vw,880px)]">
        <div className="absolute inset-0 text-forest" data-reveal="fade">
          <CircleText id="circle-dn" text="DRY FRUITS • NUTS • DATES • SEEDS • FROM THE VALLEY • " className="h-full w-full" size={880} />
        </div>
        {/* plate */}
        <div className="absolute inset-[11%] rounded-full bg-sage" data-reveal="scale">
          <div className="absolute inset-[3%] rounded-full border-[10px] border-dashed border-forest md:border-[16px]" data-rotate-scroll="40" />
          <div className="absolute inset-[7.5%]">
            <div className="relative h-full w-full overflow-hidden rounded-full bg-cream">
              <div className="absolute inset-0 [clip-path:polygon(0_0,100%_0,0_100%)]">
                <Image src="/images/products/kimia-dates/lifestyle.webp" alt="Velora Valley Kimia Dates" fill sizes="(min-width: 1024px) 640px, 70vw" className="scale-110 object-cover" />
              </div>
              <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                <Image src="/images/products/salted-roasted-pistachios/lifestyle.webp" alt="Velora Valley Salted and Roasted Pistachios" fill sizes="(min-width: 1024px) 640px, 70vw" className="scale-110 object-cover" />
              </div>
              <div className="absolute left-1/2 top-1/2 h-[3px] w-[150%] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-[repeating-linear-gradient(90deg,#fbf8f1_0_14px,transparent_14px_24px)]" />
            </div>
          </div>
        </div>

        {/* cards (desktop overlap) */}
        <div className="absolute left-[-2%] top-[18%] hidden w-[300px] md:block" data-reveal="left">
          <CircleCard title="Dates" text="Safawi, Kimia and Arabian dates — seeded and seedless, in pouches, trays and gift boxes." href="/shop?category=dates" cta="Shop dates" />
        </div>
        <div className="absolute bottom-[14%] right-[-2%] hidden w-[300px] md:block" data-reveal="right">
          <CircleCard title="Nuts" text="Premium cashews, California almonds and salted, roasted pistachios." href="/shop?category=nuts" cta="Shop nuts" />
        </div>
      </div>
      <div className="container-site mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 md:hidden">
        <CircleCard title="Dates" text="Safawi, Kimia and Arabian dates — seeded and seedless, in pouches, trays and gift boxes." href="/shop?category=dates" cta="Shop dates" />
        <CircleCard title="Nuts" text="Premium cashews, California almonds and salted, roasted pistachios." href="/shop?category=nuts" cta="Shop nuts" />
      </div>
    </section>
  );
}

function CircleCard({ title, text, href, cta }: { title: string; text: string; href: string; cta: string }) {
  return (
    <div className="drop">
      <div className="stamp text-center">
        <div className="px-4 py-5">
          <h3 className="text-[56px] leading-none">{title}</h3>
          <p className="mt-2 text-[12.5px] leading-relaxed text-forest/80">{text}</p>
          <Link href={href} className="btn btn-forest mt-4 w-full">
            {cta}
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Business ───────────────────────── */
const BIZ_ICONS = { distributor: IconHandshake, retail: IconStore, bulk: IconBox, horeca: IconCloche, export: IconGlobe, franchise: IconBadge } as const;

export function BusinessSection() {
  return (
    <section className="grain relative overflow-hidden bg-forest-deep text-cream" aria-labelledby="biz-title">
      <div className="edge-dash [--c:theme(colors.cream.DEFAULT)]" aria-hidden />
      <div className="absolute inset-0 opacity-25">
        <div className="absolute inset-x-0 -bottom-[10%] -top-[10%]" data-parallax="0.08">
          <Image src="/images/brand/valley-wide.webp" alt="" fill sizes="100vw" className="object-cover" />
        </div>
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-forest-deep via-forest-deep/80 to-forest-deep/95" />

      <div className="container-site relative grid grid-cols-1 gap-14 py-20 md:py-28 lg:grid-cols-[1fr_minmax(0,560px)] lg:items-center">
        <div className="relative min-h-[460px] sm:min-h-[520px]">
          <p className="script -rotate-3 text-[34px] text-gold-light" data-reveal="fade">
            Partner with us
          </p>
          <h2 id="biz-title" className="mt-1 max-w-[12ch] text-display-lg" data-split="words">
            Grow with Velora Valley
          </h2>
          <p className="mt-5 max-w-[46ch] text-[14px] text-cream/80" data-reveal="up">
            Premium quality dry fruits, seeds and ready-to-eat products crafted for modern retail, bulk supply and distribution across India.
          </p>
          <div className="relative mt-10 h-[260px] sm:h-[300px]" aria-hidden>
            <div className="absolute left-0 top-0 w-[44%] max-w-[240px]" data-reveal="drop">
              <Polaroid src="/images/process/distribution.webp" alt="" tilt={-5} ratio="4/3" sizes="240px" />
            </div>
            <div className="absolute left-[30%] top-[24%] w-[44%] max-w-[240px]" data-reveal="drop" data-delay="0.1">
              <Polaroid src="/images/process/packaging.webp" alt="" tilt={4} ratio="4/3" sizes="240px" />
            </div>
            <div className="absolute right-0 top-[4%] w-[30%] max-w-[170px]" data-reveal="scale" data-delay="0.2">
              <OctBadge value="6" label="Ways to partner" tone="gold" line="forest" />
            </div>
          </div>
        </div>

        <div data-reveal="up">
          <Frame tone="forest" line="cream" n={22} innerClassName="p-6 sm:p-9">
            <h3 className="serif-italic text-[28px] normal-case" style={{ fontVariationSettings: "'SOFT' 100, 'WONK' 1" }}>
              Business opportunities
            </h3>
            <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(Object.keys(BUSINESS_INTERESTS) as (keyof typeof BUSINESS_INTERESTS)[]).map((k) => {
                const Icon = BIZ_ICONS[k];
                return (
                  <li key={k}>
                    <Link
                      href={`/business?interest=${k}`}
                      className="group flex h-full items-center gap-3 rounded-[10px] border border-cream/15 p-3 transition-all duration-500 ease-out-expo hover:-translate-y-0.5 hover:border-gold hover:bg-cream/5"
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream text-forest transition-colors duration-500 group-hover:bg-gold">
                        <Icon width={20} />
                      </span>
                      <span className="text-[13px] leading-snug">{BUSINESS_INTERESTS[k]}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <ButtonLink href="/business" size="lg" icon={<IconArrowRight width={18} />}>
                Send a business enquiry
              </ButtonLink>
              <a href={`tel:${site.phones[0].replace(/\s/g, "")}`} className="link-underline text-[13px] text-cream/80">
                or call {site.phones[0]}
              </a>
            </div>
          </Frame>
        </div>
      </div>
    </section>
  );
}
