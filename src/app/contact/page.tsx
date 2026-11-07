import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/config/site";
import { PageHeader } from "@/components/ui/PageHeader";
import { Frame } from "@/components/ui/Ornaments";
import { EnquiryForm } from "@/components/forms/EnquiryForm";
import { IconMail, IconPhone, IconPin } from "@/components/ui/Icons";

export const metadata: Metadata = { title: "Contact", description: `Contact ${site.company}, makers of Velora Valley, in Anantapur, Andhra Pradesh.` };

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const feedback = (await searchParams).topic === "feedback";
  const mapQuery = encodeURIComponent(`${site.address.line1}, ${site.address.city}, ${site.address.state} ${site.address.pincode}`);
  return (
    <>
      <PageHeader
        title="Say hello"
        script="We'd love to hear from you"
        crumbs={[{ label: "Contact" }]}
        intro={feedback ? "Tried Velora Valley? Tell us what you think — your feedback helps us improve." : "Questions about a product or an order? Write to us, call, or visit us in Anantapur."}
        photos={["/images/products/fruit-and-nut-cookies/lifestyle.webp", "/images/products/osmania-biscuits/lifestyle.webp"]}
      />
      <div className="container-site grid grid-cols-1 gap-10 pb-24 lg:grid-cols-[1fr_420px]">
        <div data-reveal="up">
          <Frame tone="light" n={24} innerClassName="p-6 sm:p-10">
            <h2 className="text-[38px] leading-none">{feedback ? "Share your feedback" : "Send us a message"}</h2>
            <div className="mt-8">
              <EnquiryForm type="contact" defaultMessage={feedback ? "My feedback on Velora Valley: " : ""} />
            </div>
          </Frame>
        </div>
        <aside className="space-y-5">
          <div data-reveal="up">
            <Frame tone="sage" n={18} innerClassName="p-6 text-[13.5px]">
              <h2 className="text-[30px] leading-none">{site.company}</h2>
              <ul className="mt-5 space-y-4">
                <li className="flex gap-3">
                  <IconPin className="mt-0.5 shrink-0 text-leaf" />
                  <span>
                    {site.address.line1},
                    <br />
                    {site.address.city}, {site.address.state} {site.address.pincode}, {site.address.country}
                    <br />
                    <a href={`https://www.google.com/maps/search/?api=1&query=${mapQuery}`} target="_blank" rel="noopener noreferrer" className="link-underline text-[12px] text-leaf">
                      Open in Google Maps
                    </a>
                  </span>
                </li>
                <li className="flex gap-3">
                  <IconPhone className="mt-0.5 shrink-0 text-leaf" />
                  <span className="flex flex-col">
                    {site.phones.map((p) => (
                      <a key={p} href={`tel:${p.replace(/\s/g, "")}`} className="link-underline self-start">
                        {p}
                      </a>
                    ))}
                  </span>
                </li>
                <li className="flex gap-3">
                  <IconMail className="mt-0.5 shrink-0 text-leaf" />
                  <a href={`mailto:${site.email}`} className="link-underline break-all">
                    {site.email}
                  </a>
                </li>
              </ul>
            </Frame>
          </div>
          <div data-reveal="up" className="rounded-[14px] bg-forest p-6 text-cream">
            <p className="script text-[30px] text-gold-light">For businesses</p>
            <p className="mt-2 text-[13px] text-cream/80">Distributor, dealer, retail, HoReCa, bulk, export or franchise enquiry?</p>
            <Link href="/business" className="btn mt-5">
              Business enquiry
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
