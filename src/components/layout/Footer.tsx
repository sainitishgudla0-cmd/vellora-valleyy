import Image from "next/image";
import Link from "next/link";
import { site } from "@/config/site";
import { categories } from "@/data/categories";
import { NewsletterForm } from "@/components/forms/NewsletterForm";
import { IconFacebook, IconInstagram, IconMail, IconPhone, IconPin, IconX } from "@/components/ui/Icons";
import { Polaroid } from "@/components/ui/Ornaments";

const company = [
  { label: "Our Story", href: "/our-story" },
  { label: "Quality Process", href: "/quality" },
  { label: "Business & Wholesale", href: "/business" },
  { label: "Contact", href: "/contact" },
  { label: "Shop All", href: "/shop" },
];

export function Footer() {
  return (
    <footer className="grain relative overflow-hidden bg-forest text-cream">
      <div className="edge-dash [--c:theme(colors.cream.DEFAULT)]" aria-hidden />
      {/* watermark mark */}
      <Image
        src="/images/brand/mark-cream.png"
        alt=""
        width={420}
        height={520}
        className="pointer-events-none absolute -bottom-24 -right-16 w-[340px] opacity-[0.06] md:w-[460px]"
        aria-hidden
      />

      <div className="container-site relative pb-8 pt-16 md:pt-24">
        {/* big sign-off */}
        <div className="grid grid-cols-1 gap-10 border-b border-cream/15 pb-14 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div>
            <p className="script text-[34px] text-gold-light" data-reveal="up">
              From the valley, with care
            </p>
            <h2 className="mt-2 text-display-lg" data-split="words">
              Nature&apos;s finest. Delivered to your table.
            </h2>
            <div className="mt-8 flex flex-wrap gap-3" data-reveal="up">
              <Link href="/shop" className="btn btn-lg">
                Explore our products
              </Link>
              <Link href="/business" className="btn btn-lg btn-cream">
                Business enquiry
              </Link>
            </div>
          </div>
          <div className="relative hidden min-h-[320px] lg:block" aria-hidden>
            <div className="absolute right-[34%] top-2 w-[220px]" data-reveal="drop">
              <Polaroid src="/images/products/kimia-dates/lifestyle.webp" alt="" tilt={-7} caption="Kimia dates" sizes="220px" />
            </div>
            <div className="absolute right-2 top-12 w-[230px]" data-reveal="drop" data-delay="0.1">
              <Polaroid src="/images/products/california-almonds/lifestyle.webp" alt="" tilt={6} caption="Almonds" sizes="230px" />
            </div>
          </div>
        </div>

        {/* columns */}
        <div className="grid grid-cols-1 gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1.4fr]">
          <div>
            <Image src="/images/brand/logo-cream.png" alt="Velora Valley" width={555} height={247} className="w-[190px]" />
            <p className="mt-5 max-w-[34ch] text-[13px] leading-relaxed text-cream/75">
              Velora Valley is the brand of {site.company}, Anantapur — manufacturers, processors and packers of dry fruits, dates, seeds,
              ready-to-cook foods, biscuits, chocolates and fruit products.
            </p>
            <div className="mt-6 flex gap-2">
              {[
                { href: site.social.instagram, label: "Instagram", Icon: IconInstagram },
                { href: site.social.facebook, label: "Facebook", Icon: IconFacebook },
                { href: site.social.x, label: "X", Icon: IconX },
              ].map(({ href, label, Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Velora Valley on ${label}`}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-cream/25 transition-all duration-500 ease-out-expo hover:-translate-y-1 hover:border-gold hover:bg-gold hover:text-forest-deep"
                >
                  <Icon width={18} />
                </a>
              ))}
              <span className="ml-1 self-center text-[12px] text-cream/60">{site.social.handle}</span>
            </div>
          </div>

          <FooterCol title="Products">
            {categories.map((c) => (
              <li key={c.slug}>
                <Link href={`/shop?category=${c.slug}`} className="link-underline">
                  {c.name}
                </Link>
              </li>
            ))}
          </FooterCol>

          <FooterCol title="Company">
            {company.map((c) => (
              <li key={c.href}>
                <Link href={c.href} className="link-underline">
                  {c.label}
                </Link>
              </li>
            ))}
          </FooterCol>

          <div>
            <h3 className="serif-italic mb-4 border-b border-cream/20 pb-3 text-[24px] normal-case">Contact</h3>
            <ul className="space-y-3 text-[13px] text-cream/80">
              <li className="flex gap-2.5">
                <IconPin width={17} className="mt-0.5 shrink-0 text-gold" />
                <span>
                  {site.company}
                  <br />
                  {site.address.line1}, {site.address.city},
                  <br />
                  {site.address.state} {site.address.pincode}, {site.address.country}
                </span>
              </li>
              <li className="flex gap-2.5">
                <IconPhone width={17} className="mt-0.5 shrink-0 text-gold" />
                <span className="flex flex-col">
                  {site.phones.map((p) => (
                    <a key={p} href={`tel:${p.replace(/\s/g, "")}`} className="link-underline self-start">
                      {p}
                    </a>
                  ))}
                </span>
              </li>
              <li className="flex gap-2.5">
                <IconMail width={17} className="mt-0.5 shrink-0 text-gold" />
                <a href={`mailto:${site.email}`} className="link-underline break-all">
                  {site.email}
                </a>
              </li>
            </ul>
            <div className="mt-7">
              <NewsletterForm />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-cream/15 pt-6 text-[11.5px] text-cream/60 md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {site.company}. Velora Valley™ — all rights reserved.
          </p>
          <p>FSSAI Lic. No. {site.fssaiLicense}</p>
          <p>
            Business enquiries:{" "}
            <Link href="/business" className="link-underline text-cream">
              distributors, retail, HoReCa, export
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="serif-italic mb-4 border-b border-cream/20 pb-3 text-[24px] normal-case">{title}</h3>
      <ul className="space-y-2 text-[13px] text-cream/80">{children}</ul>
    </div>
  );
}
