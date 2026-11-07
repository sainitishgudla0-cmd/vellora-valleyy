import type { Metadata } from "next";
import { site } from "@/config/site";
import { BUSINESS_INTERESTS } from "@/lib/validation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Frame, OctBadge, Polaroid } from "@/components/ui/Ornaments";
import { EnquiryForm } from "@/components/forms/EnquiryForm";
import { IconBadge, IconBox, IconCloche, IconGlobe, IconHandshake, IconStore } from "@/components/ui/Icons";

export const metadata: Metadata = {
  title: "Business & Wholesale",
  description: "Distributor and dealer opportunities, retail tie-ups, bulk and wholesale supply, HoReCa supply, export enquiries and franchise opportunities with Velora Valley.",
};

const ITEMS = [
  { k: "distributor", Icon: IconHandshake, text: "Distributor & dealer opportunities available." },
  { k: "retail", Icon: IconStore, text: "Retail and supermarket tie-ups for our full range." },
  { k: "bulk", Icon: IconBox, text: "Bulk orders and wholesale supply." },
  { k: "horeca", Icon: IconCloche, text: "Supply for hotels, restaurants and catering." },
  { k: "export", Icon: IconGlobe, text: "Export enquiries welcome." },
  { k: "franchise", Icon: IconBadge, text: "Franchise opportunities available." },
] as const;

export default async function BusinessPage(props: { searchParams: Promise<{ interest?: string }> }) {
  const searchParams = await props.searchParams;
  const interest = searchParams.interest && searchParams.interest in BUSINESS_INTERESTS ? (searchParams.interest as keyof typeof BUSINESS_INTERESTS) : undefined;
  return (
    <>
      <PageHeader
        tone="forest"
        title="Grow with us"
        script="Business & wholesale"
        crumbs={[{ label: "Business" }]}
        intro="Premium quality dry fruits, seeds and ready-to-eat products crafted for modern retail, bulk supply and distribution across India."
      />
      <section className="container-site py-16 md:py-20">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map(({ k, Icon, text }, i) => (
            <li key={k} data-reveal="up" data-delay={String(i * 0.05)}>
              <a href={`?interest=${k}#enquiry`} className="group block h-full rounded-[14px] bg-sage p-[5px] transition-transform duration-700 ease-out-expo hover:-translate-y-1">
                <div className="flex h-full items-start gap-4 rounded-[10px] border-[1.5px] border-forest/60 p-5">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-forest text-cream transition-all duration-500 group-hover:rotate-[-10deg] group-hover:bg-gold group-hover:text-forest">
                    <Icon />
                  </span>
                  <span>
                    <span className="display block text-[26px] leading-[0.95]">{BUSINESS_INTERESTS[k]}</span>
                    <span className="mt-1 block text-[12.5px] text-forest/75">{text}</span>
                  </span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section id="enquiry" className="container-site grid grid-cols-1 gap-12 pb-24 lg:grid-cols-[1fr_minmax(0,640px)]">
        <div className="relative">
          <h2 className="text-display-md" data-split="words">
            Send a business enquiry
          </h2>
          <p className="mt-4 max-w-[44ch] text-[13.5px] text-forest/80" data-reveal="up">
            Tell us what you need and where you are. Our team will get back to you with product, pricing and supply details.
          </p>
          <ul className="mt-6 space-y-1 text-[13px]" data-reveal="up">
            {site.phones.map((p) => (
              <li key={p}>
                <a href={`tel:${p.replace(/\s/g, "")}`} className="link-underline">
                  {p}
                </a>
              </li>
            ))}
            <li>
              <a href={`mailto:${site.email}?subject=Business%20enquiry`} className="link-underline break-all">
                {site.email}
              </a>
            </li>
          </ul>
          <div className="relative mt-10 hidden h-[340px] lg:block" aria-hidden>
            <div className="absolute left-0 top-0 w-[230px]" data-reveal="drop">
              <Polaroid src="/images/process/distribution.webp" alt="" tilt={-5} ratio="4/3" sizes="230px" />
            </div>
            <div className="absolute left-[150px] top-[120px] w-[230px]" data-reveal="drop" data-delay="0.1">
              <Polaroid src="/images/process/packaging.webp" alt="" tilt={5} ratio="4/3" sizes="230px" />
            </div>
            <div className="absolute left-[330px] top-0 w-[160px]" data-reveal="scale" data-delay="0.2">
              <OctBadge value="6" label="Ways to partner" tone="gold" line="forest" />
            </div>
          </div>
        </div>
        <div data-reveal="up">
          <Frame tone="light" n={24} innerClassName="p-6 sm:p-10">
            <EnquiryForm key={interest ?? "none"} type="business" defaultInterest={interest} />
          </Frame>
        </div>
      </section>
    </>
  );
}
