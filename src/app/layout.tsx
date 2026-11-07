import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Bricolage_Grotesque, Caveat, DM_Mono, Fraunces } from "next/font/google";
import "@/styles/globals.css";
import { site } from "@/config/site";
import { getProducts } from "@/lib/catalog";
import { AnnouncementBar } from "@/components/layout/AnnouncementBar";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CartDrawer, QuickView, Toast } from "@/components/layout/Overlays";
import { PageLoader } from "@/components/layout/PageLoader";
import { SmoothScroll } from "@/components/motion/SmoothScroll";
import { MotionManager } from "@/components/motion/MotionManager";
import type { MenuProduct } from "@/components/layout/types";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", axes: ["wdth"], display: "swap" });
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", style: ["normal", "italic"], axes: ["SOFT", "WONK", "opsz"], display: "swap" });
const mono = DM_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["300", "400", "500"], display: "swap" });
const script = Caveat({ subsets: ["latin"], variable: "--font-script", weight: ["500", "700"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: `${site.name} — Premium Dry Fruits, Nuts, Dates & Seeds`, template: `%s · ${site.name}` },
  description: site.description,
  openGraph: { type: "website", siteName: site.name, images: ["/images/brand/valley-wide.webp"] },
  icons: { icon: "/images/brand/mark-forest.png" },
};

export const viewport: Viewport = { themeColor: "#13402d", width: "device-width", initialScale: 1 };

export const revalidate = 60;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const products = await getProducts();
  const menuProducts: MenuProduct[] = products.map((p) => ({
    slug: p.slug,
    name: p.name,
    image: p.images.lifestyle,
    categories: p.categories,
    fromPrice: Math.min(...p.variants.map((v) => v.price)),
  }));

  const orgLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.company,
    brand: site.name,
    url: site.url,
    email: site.email,
    telephone: site.phones[0],
    address: {
      "@type": "PostalAddress",
      streetAddress: site.address.line1,
      addressLocality: site.address.city,
      addressRegion: site.address.state,
      postalCode: site.address.pincode,
      addressCountry: "IN",
    },
  };

  return (
    <html lang="en-IN" className={`${display.variable} ${serif.variable} ${mono.variable} ${script.variable}`} suppressHydrationWarning>
      <head>
        {/* mark JS-enabled before paint so reveal targets start hidden; reveal everything if scripts stall */}
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.classList.add('js');setTimeout(function(){document.documentElement.classList.add('motion-fallback')},4000);`,
          }}
        />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded focus:bg-gold focus:px-4 focus:py-2">
          Skip to content
        </a>
        <PageLoader />
        <AnnouncementBar />
        <Suspense fallback={<div className="h-[80px]" />}>
          <Header menuProducts={menuProducts} />
        </Suspense>
        <main id="main">{children}</main>
        <Footer />
        <CartDrawer />
        <QuickView />
        <Toast />
        <SmoothScroll />
        <MotionManager />
      </body>
    </html>
  );
}
