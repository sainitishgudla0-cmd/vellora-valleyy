"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { nav } from "@/config/site";
import { categories } from "@/data/categories";
import type { CategorySlug } from "@/data/types";
import { cartCount, useCart, useCartHydrated } from "@/store/cart";
import { useUI } from "@/store/ui";
import { cn, formatPrice } from "@/lib/format";
import { IconArrowRight, IconBag, IconChevron } from "@/components/ui/Icons";
import { Roll } from "@/components/ui/Button";
import { MobileMenu } from "./MobileMenu";
import type { MenuProduct } from "./types";

type MenuKey = "shop" | "dry-fruits" | "nuts-seeds" | "dates";

const MENU_CATS: Record<Exclude<MenuKey, "shop">, { cats: CategorySlug[]; title: string; href: string; feature: string; script: string }> = {
  "dry-fruits": { cats: ["dry-fruits"], title: "Dry Fruits", href: "/shop?category=dry-fruits", feature: "/images/products/premium-cashews/lifestyle.webp", script: "Handpicked goodness" },
  "nuts-seeds": { cats: ["nuts", "seeds"], title: "Nuts & Seeds", href: "/shop?category=nuts,seeds", feature: "/images/products/roasted-super-seed-mix/lifestyle.webp", script: "Small seeds, big crunch" },
  dates: { cats: ["dates"], title: "Dates", href: "/shop?category=dates", feature: "/images/products/safawi-dates/lifestyle.webp", script: "Sweet by nature" },
};

export function Logo({ className, tone = "forest" }: { className?: string; tone?: "forest" | "cream" }) {
  return (
    <Image
      src={tone === "forest" ? "/images/brand/logo-forest.png" : "/images/brand/logo-cream.png"}
      alt="Velora Valley"
      width={555}
      height={247}
      priority
      className={cn("h-auto", className)}
    />
  );
}

export function Header({ menuProducts }: { menuProducts: MenuProduct[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const lines = useCart((s) => s.lines);
  const hydrated = useCartHydrated();
  const count = hydrated ? cartCount(lines) : 0;
  const { openCart, menuOpen, setMenu } = useUI();
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [bump, setBump] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const prevCount = useRef(count);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // close menus on navigation
  useEffect(() => {
    setOpen(null);
    setMenu(false);
  }, [pathname, search, setMenu]);

  // cart badge bump
  useEffect(() => {
    if (count > prevCount.current) {
      setBump(true);
      const t = window.setTimeout(() => setBump(false), 600);
      prevCount.current = count;
      return () => window.clearTimeout(t);
    }
    prevCount.current = count;
  }, [count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const enter = useCallback((k: MenuKey | null) => {
    window.clearTimeout(closeTimer.current);
    setOpen(k);
  }, []);
  const leave = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(null), 160);
  }, []);

  const isActive = (href: string) => {
    const [path, qs] = href.split("?");
    if (path === "/") return pathname === "/";
    if (qs) return pathname === path && search.get("category") === new URLSearchParams(qs).get("category");
    if (path === "/shop") return pathname.startsWith("/shop") && !search.get("category");
    return pathname.startsWith(path);
  };

  return (
    <>
      <header className="pointer-events-none sticky top-0 z-50 px-3 pt-3 sm:px-4 lg:px-6" onMouseLeave={leave}>
        {/* ───────── desktop ───────── */}
        <div className="pointer-events-auto mx-auto hidden max-w-site items-stretch gap-3 lg:flex">
          <div
            className={cn(
              "relative flex flex-1 items-center rounded-[10px] bg-cream-light px-6 transition-[box-shadow,height] duration-500",
              scrolled ? "h-[60px] shadow-card" : "h-[68px] shadow-[0_1px_0_rgba(15,52,36,.08)]",
            )}
          >
            <Link href="/" aria-label="Velora Valley home" className="shrink-0" onMouseEnter={() => enter(null)}>
              <Logo className={cn("transition-[width] duration-500", scrolled ? "w-[108px]" : "w-[124px]")} />
            </Link>
            <nav aria-label="Main" className="mx-auto">
              <ul className="flex items-center gap-1 xl:gap-2">
                {nav.map((item) => {
                  const menu = "menu" in item ? (item.menu as MenuKey) : null;
                  const active = isActive(item.href);
                  return (
                    <li key={item.label} onMouseEnter={() => enter(menu)} className="relative">
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        aria-expanded={menu ? open === menu : undefined}
                        aria-haspopup={menu ? "true" : undefined}
                        onFocus={() => menu && enter(menu)}
                        className={cn(
                          "roll-host group flex items-center gap-1 rounded-full px-3 py-2 text-[13px] transition-colors duration-300 hover:bg-sage xl:px-3.5",
                          active && "bg-sage/70",
                        )}
                      >
                        <Roll>{item.label}</Roll>
                        {menu && <IconChevron width={14} height={14} className={cn("transition-transform duration-300", open === menu && "rotate-180")} />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <button
              onClick={openCart}
              onMouseEnter={() => enter(null)}
              className="group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-sage"
              aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
            >
              <IconBag className="transition-transform duration-500 ease-out-expo group-hover:-rotate-12 group-hover:scale-110" />
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1 text-[11px] font-medium text-forest-deep transition-transform duration-300",
                  bump && "scale-125",
                  count === 0 && "opacity-0",
                )}
              >
                {count}
              </span>
            </button>
            {/* connector to CTA, like a ticket stub */}
            <span aria-hidden className="absolute -right-3 top-1/2 h-[2px] w-3 -translate-y-1/2 bg-forest" />
          </div>
          <Link
            href="/shop"
            onMouseEnter={() => enter(null)}
            className={cn("btn flex items-center px-9 text-[19px] transition-[height]", scrolled ? "h-[60px]" : "h-[68px]")}
          >
            <Roll>Shop Now</Roll>
            <IconArrowRight width={18} height={18} />
          </Link>
        </div>

        {/* dropdown panels */}
        <AnimatePresence>
          {open && (
            <motion.div
              key="panel"
              initial={{ opacity: 0, y: -10, clipPath: "inset(0 0 100% 0 round 14px)" }}
              animate={{ opacity: 1, y: 0, clipPath: "inset(0 0 0% 0 round 14px)" }}
              exit={{ opacity: 0, y: -6, clipPath: "inset(0 0 100% 0 round 14px)", transition: { duration: 0.25 } }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              onMouseEnter={() => enter(open)}
              onMouseLeave={leave}
              className="pointer-events-auto absolute inset-x-3 top-full mx-auto mt-2 hidden max-w-site sm:inset-x-4 lg:inset-x-6 lg:block"
            >
              <div className="rounded-[14px] bg-cream-light p-6 shadow-lift">
                {open === "shop" ? <ShopPanel /> : <CategoryPanel k={open} products={menuProducts} />}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ───────── mobile / tablet ───────── */}
        <div className="pointer-events-auto flex items-stretch gap-2 lg:hidden">
          <Link href="/shop" className="btn btn-sm h-12 px-4 text-[16px]">
            Shop
          </Link>
          <Link href="/" aria-label="Velora Valley home" className="flex h-12 flex-1 items-center justify-center rounded-[10px] bg-cream-light shadow-card">
            <Logo className="w-[92px]" />
          </Link>
          <button
            onClick={openCart}
            aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
            className="relative flex h-12 w-12 items-center justify-center rounded-[10px] bg-cream-light shadow-card"
          >
            <IconBag />
            {count > 0 && (
              <span className={cn("absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gold px-1 text-[10px] font-medium transition-transform", bump && "scale-125")}>
                {count}
              </span>
            )}
          </button>
          <button
            onClick={() => setMenu(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            className="serif-italic flex h-12 items-center rounded-[10px] bg-sage px-4 text-[17px] shadow-card"
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>
      <MobileMenu products={menuProducts} />
    </>
  );
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.08 } },
};
const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

function ShopPanel() {
  return (
    <div className="grid grid-cols-[1fr_280px] gap-6">
      <motion.ul variants={stagger} initial="hidden" animate="show" className="grid grid-cols-4 gap-3">
        {categories.map((c) => (
          <motion.li key={c.slug} variants={item}>
            <Link href={`/shop?category=${c.slug}`} className="group block overflow-hidden rounded-[10px] bg-dough">
              <div className="relative aspect-[5/3] overflow-hidden">
                <Image src={c.image} alt="" fill sizes="240px" className="object-cover transition-transform duration-700 ease-out-expo group-hover:scale-110" />
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="display text-[19px] leading-none">{c.short}</span>
                <IconArrowRight width={16} height={16} className="-translate-x-2 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
              </div>
            </Link>
          </motion.li>
        ))}
        <motion.li variants={item}>
          <Link href="/shop" className="group flex h-full flex-col justify-between rounded-[10px] bg-forest p-4 text-cream">
            <span className="eyebrow text-gold">Everything</span>
            <span className="display text-[30px] leading-[0.9]">
              Shop all
              <br />
              products
            </span>
            <IconArrowRight className="transition-transform duration-500 group-hover:translate-x-2" />
          </Link>
        </motion.li>
      </motion.ul>
      <div className="relative overflow-hidden rounded-[10px] bg-forest p-5 text-cream">
        <Image src="/images/brand/valley-tall.webp" alt="" fill sizes="280px" className="object-cover opacity-70" />
        <div className="relative flex h-full flex-col justify-end">
          <p className="script text-[30px] text-gold-light">For your business</p>
          <p className="mt-1 text-[13px] leading-snug">Distributor, retail, HoReCa, bulk and export enquiries are welcome.</p>
          <Link href="/business" className="btn btn-sm mt-4 self-start">
            <Roll>Business enquiry</Roll>
          </Link>
        </div>
      </div>
    </div>
  );
}

function CategoryPanel({ k, products }: { k: Exclude<MenuKey, "shop">; products: MenuProduct[] }) {
  const cfg = MENU_CATS[k];
  const list = products.filter((p) => p.categories.some((c) => cfg.cats.includes(c)));
  return (
    <div className="grid grid-cols-[300px_1fr] gap-8">
      <Link href={cfg.href} className="group relative block overflow-hidden rounded-[10px]">
        <div className="relative aspect-[4/5]">
          <Image src={cfg.feature} alt="" fill sizes="300px" className="object-cover transition-transform duration-1000 ease-out-expo group-hover:scale-105" />
        </div>
        <div className="absolute inset-x-3 bottom-3 rounded-[8px] bg-cream-light/95 p-3">
          <p className="script text-[24px] text-leaf">{cfg.script}</p>
          <p className="display text-[26px] leading-none">All {cfg.title}</p>
        </div>
      </Link>
      <div>
        <div className="mb-4 flex items-baseline justify-between border-b border-forest/15 pb-3">
          <h3 className="text-[34px] leading-none">{cfg.title}</h3>
          <Link href={cfg.href} className="link-underline text-[13px]">
            View all {list.length}
          </Link>
        </div>
        <motion.ul variants={stagger} initial="hidden" animate="show" className="grid grid-cols-3 gap-x-6 gap-y-1">
          {list.slice(0, 15).map((p) => (
            <motion.li key={p.slug} variants={item}>
              <Link href={`/product/${p.slug}`} className="group flex items-center gap-3 rounded-[8px] p-2 transition-colors hover:bg-sage/60">
                <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-dough">
                  <Image src={p.image} alt="" fill sizes="48px" className="object-cover transition-transform duration-500 group-hover:scale-110" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] leading-tight">{p.name}</span>
                  <span className="text-[11px] text-forest/60">from {formatPrice(p.fromPrice)}</span>
                </span>
              </Link>
            </motion.li>
          ))}
        </motion.ul>
      </div>
    </div>
  );
}
