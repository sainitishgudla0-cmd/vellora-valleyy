"use client";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { nav, site } from "@/config/site";
import { categories } from "@/data/categories";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/format";
import { IconChevron, IconMail, IconPhone } from "@/components/ui/Icons";
import { getLenis } from "@/components/motion/SmoothScroll";
import type { MenuProduct } from "./types";

export function MobileMenu({ products }: { products: MenuProduct[] }) {
  const { menuOpen, setMenu } = useUI();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const l = getLenis();
    if (menuOpen) {
      l?.stop();
      document.documentElement.style.overflow = "hidden";
    } else {
      l?.start();
      document.documentElement.style.overflow = "";
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, setMenu]);

  return (
    <AnimatePresence>
      {menuOpen && (
        <motion.div
          id="mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          initial={{ clipPath: "circle(0% at 92% 4%)" }}
          animate={{ clipPath: "circle(150% at 92% 4%)" }}
          exit={{ clipPath: "circle(0% at 92% 4%)", transition: { duration: 0.45, ease: [0.76, 0, 0.24, 1] } }}
          transition={{ duration: 0.7, ease: [0.76, 0, 0.24, 1] }}
          className="grain fixed inset-0 z-[45] overflow-y-auto bg-forest pb-10 pt-[104px] text-cream lg:hidden"
          data-lenis-prevent
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[40vh] opacity-30">
            <Image src="/images/brand/valley-wide.webp" alt="" fill sizes="100vw" className="object-cover object-top" />
          </div>
          <motion.ul
            className="relative px-5"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.2 } } }}
          >
            {nav.map((item) => {
              const menu = "menu" in item ? item.menu : null;
              const sub =
                menu === "shop"
                  ? categories.map((c) => ({ href: `/shop?category=${c.slug}`, label: c.name }))
                  : menu
                    ? products
                        .filter((p) =>
                          p.categories.some((c) => (menu === "nuts-seeds" ? c === "nuts" || c === "seeds" : c === menu)),
                        )
                        .map((p) => ({ href: `/product/${p.slug}`, label: p.name }))
                    : null;
              return (
                <motion.li
                  key={item.label}
                  variants={{ hidden: { opacity: 0, y: 30 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } } }}
                  className="border-b border-cream/15"
                >
                  <div className="flex items-center justify-between">
                    <Link href={item.href} onClick={() => setMenu(false)} className="display block py-3 text-[44px] leading-none">
                      {item.label}
                    </Link>
                    {sub && (
                      <button
                        onClick={() => setExpanded(expanded === item.label ? null : item.label)}
                        aria-expanded={expanded === item.label}
                        aria-label={`Show ${item.label} links`}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-cream/10"
                      >
                        <IconChevron className={cn("transition-transform duration-300", expanded === item.label && "rotate-180")} />
                      </button>
                    )}
                  </div>
                  <AnimatePresence initial={false}>
                    {sub && expanded === item.label && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 pb-4 text-[14px] text-cream/80">
                          {sub.map((s) => (
                            <li key={s.href}>
                              <Link href={s.href} onClick={() => setMenu(false)} className="block py-1">
                                {s.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </motion.ul>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.6 } }}
            className="relative mt-8 space-y-3 px-5 text-[14px]"
          >
            <Link href="/business" onClick={() => setMenu(false)} className="btn">
              Business enquiry
            </Link>
            <a href={`tel:${site.phones[0].replace(/\s/g, "")}`} className="flex items-center gap-2">
              <IconPhone width={16} /> {site.phones[0]}
            </a>
            <a href={`mailto:${site.email}`} className="flex items-center gap-2 break-all">
              <IconMail width={16} /> {site.email}
            </a>
            <p className="script pt-2 text-[28px] text-gold-light">Nature&apos;s finest, delivered.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
