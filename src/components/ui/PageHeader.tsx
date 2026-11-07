import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Polaroid } from "./Ornaments";

/** Editorial inner-page header: breadcrumb, oversized title, script accent and optional tilted photos. */
export function PageHeader({
  title,
  script,
  intro,
  crumbs = [],
  photos,
  children,
  tone = "cream",
}: {
  title: string;
  script?: string;
  intro?: ReactNode;
  crumbs?: { label: string; href?: string }[];
  photos?: [string, string];
  children?: ReactNode;
  tone?: "cream" | "forest";
}) {
  const dark = tone === "forest";
  return (
    <section className={dark ? "grain relative mx-3 overflow-hidden rounded-[18px] bg-forest text-cream sm:mx-4 lg:mx-6" : "relative"}>
      {dark && (
        <div className="absolute inset-0 opacity-30">
          <Image src="/images/brand/valley-wide.webp" alt="" fill sizes="100vw" className="object-cover" priority />
        </div>
      )}
      <div className="container-site relative grid grid-cols-1 gap-8 pb-12 pt-10 md:pb-16 md:pt-14 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          {crumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="mb-5">
              <ol className={`flex flex-wrap items-center gap-2 text-[12px] ${dark ? "text-cream/70" : "text-forest/60"}`}>
                <li>
                  <Link href="/" className="link-underline">
                    Home
                  </Link>
                </li>
                {crumbs.map((c) => (
                  <li key={c.label} className="flex items-center gap-2">
                    <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />
                    {c.href ? (
                      <Link href={c.href} className="link-underline">
                        {c.label}
                      </Link>
                    ) : (
                      <span aria-current="page" className={dark ? "text-cream" : "text-forest"}>
                        {c.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {script && (
            <p key={`s-${script}`} className={`script -rotate-2 text-[32px] ${dark ? "text-gold-light" : "text-leaf"}`} data-reveal="fade">
              {script}
            </p>
          )}
          {/* keyed: SplitText rewrites this node's children, so React must remount it when the text changes */}
          <h1 key={title} className="text-display-xl" data-split="words">
            {title}
          </h1>
          {intro && (
            <div key={`i-${title}`} className={`mt-5 max-w-[56ch] text-[14px] ${dark ? "text-cream/80" : "text-forest/80"}`} data-reveal="up">
              {intro}
            </div>
          )}
          {children}
        </div>
        {photos && (
          <div className="relative hidden h-[260px] w-[380px] lg:block" aria-hidden>
            <div className="absolute left-0 top-0 w-[190px]" data-reveal="drop">
              <Polaroid src={photos[0]} alt="" tilt={-7} ratio="1/1" sizes="190px" priority />
            </div>
            <div className="absolute right-0 top-10 w-[200px]" data-reveal="drop" data-delay="0.12">
              <Polaroid src={photos[1]} alt="" tilt={6} ratio="1/1" sizes="200px" priority />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
