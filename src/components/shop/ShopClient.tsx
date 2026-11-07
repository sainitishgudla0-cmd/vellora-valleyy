"use client";
import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { categories } from "@/data/categories";
import type { CategorySlug, ProductView } from "@/data/types";
import { ProductCard } from "@/components/product/ProductCard";
import { IconClose, IconSearch } from "@/components/ui/Icons";
import { cn, formatPrice } from "@/lib/format";

type Sort = "featured" | "price-asc" | "price-desc" | "name";

export interface ShopState {
  q: string;
  cats: CategorySlug[];
  sort: Sort;
  max: number | null;
}

const minPrice = (p: ProductView) => Math.min(...p.variants.map((v) => v.price));

export function filterProducts(all: ProductView[], s: ShopState) {
  let list = all;
  if (s.cats.length) list = list.filter((p) => p.categories.some((c) => s.cats.includes(c)));
  if (s.q.trim()) {
    const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = `${p.name} ${p.tagline} ${p.description} ${p.categories.join(" ")} ${p.variants.map((v) => v.label).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (s.max) list = list.filter((p) => p.variants.some((v) => v.price <= s.max! * 100));
  const sorted = [...list];
  if (s.sort === "price-asc") sorted.sort((a, b) => minPrice(a) - minPrice(b));
  else if (s.sort === "price-desc") sorted.sort((a, b) => minPrice(b) - minPrice(a));
  else if (s.sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  else sorted.sort((a, b) => Number(b.featured) - Number(a.featured));
  return sorted;
}

export function ShopClient({ products, initial }: { products: ProductView[]; initial: ShopState }) {
  const pathname = usePathname();
  const [state, setState] = useState<ShopState>(initial);
  const [drawer, setDrawer] = useState(false);
  const first = useRef(true);

  // re-sync if the URL changes from outside (e.g. nav links)
  useEffect(() => setState(initial), [initial.q, initial.cats.join(","), initial.sort, initial.max]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceCeiling = useMemo(() => Math.ceil(Math.max(...products.flatMap((p) => p.variants.map((v) => v.price))) / 100 / 50) * 50, [products]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    products.forEach((p) => p.categories.forEach((k) => (c[k] = (c[k] ?? 0) + 1)));
    return c;
  }, [products]);
  const results = useMemo(() => filterProducts(products, state), [products, state]);

  // URL sync (debounced for typing)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      const sp = new URLSearchParams();
      if (state.q.trim()) sp.set("q", state.q.trim());
      if (state.cats.length) sp.set("category", state.cats.join(","));
      if (state.sort !== "featured") sp.set("sort", state.sort);
      if (state.max) sp.set("max", String(state.max));
      const qs = sp.toString();
      // shallow URL update (Next 14.1+ keeps useSearchParams in sync) — no server round-trip per keystroke
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    }, 250);
    return () => window.clearTimeout(t);
  }, [state, pathname]);

  const toggleCat = (c: CategorySlug) =>
    setState((s) => ({ ...s, cats: s.cats.includes(c) ? s.cats.filter((x) => x !== c) : [...s.cats, c] }));
  const reset = () => setState({ q: "", cats: [], sort: "featured", max: null });
  const activeCount = state.cats.length + (state.max ? 1 : 0) + (state.q ? 1 : 0);

  const Filters = (
    <div className="space-y-8">
      <div>
        <label htmlFor="shop-search" className="label">
          Search
        </label>
        <div className="relative">
          <IconSearch width={18} className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-forest/50" />
          <input
            id="shop-search"
            type="search"
            value={state.q}
            onChange={(e) => setState((s) => ({ ...s, q: e.target.value.slice(0, 80) }))}
            placeholder="Cashews, dates, chia…"
            className="input pl-7"
          />
        </div>
      </div>
      <fieldset>
        <legend className="label">Categories</legend>
        <ul className="mt-2 space-y-1">
          {categories.map((c) => {
            const on = state.cats.includes(c.slug);
            return (
              <li key={c.slug}>
                <label className={cn("group flex cursor-pointer items-center gap-3 rounded-[8px] px-2 py-2 transition-colors hover:bg-sage/60", on && "bg-sage")}>
                  <input type="checkbox" checked={on} onChange={() => toggleCat(c.slug)} className="peer sr-only" />
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-forest/40 transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-gold",
                      on && "border-forest bg-forest",
                    )}
                    aria-hidden
                  >
                    <svg viewBox="0 0 24 24" className={cn("h-3.5 w-3.5 stroke-cream transition-transform", on ? "scale-100" : "scale-0")} fill="none" strokeWidth={3}>
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                  <span className="flex-1 text-[13.5px]">{c.name}</span>
                  <span className="text-[11px] text-forest/50">{counts[c.slug] ?? 0}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div>
        <label htmlFor="shop-max" className="label flex justify-between">
          <span>Max price</span>
          <span className="normal-case tracking-normal text-forest">{state.max ? formatPrice(state.max * 100) : "Any"}</span>
        </label>
        <input
          id="shop-max"
          type="range"
          min={50}
          max={priceCeiling}
          step={10}
          value={state.max ?? priceCeiling}
          onChange={(e) => {
            const n = Number(e.target.value);
            setState((s) => ({ ...s, max: n >= priceCeiling ? null : n }));
          }}
          className="mt-3 w-full accent-forest"
        />
        <div className="mt-1 flex justify-between text-[11px] text-forest/50">
          <span>₹50</span>
          <span>₹{priceCeiling}</span>
        </div>
      </div>
      {activeCount > 0 && (
        <button onClick={reset} className="link-underline text-[13px]">
          Clear all filters
        </button>
      )}
    </div>
  );

  return (
    <div className="container-site pb-24">
      {/* toolbar */}
      <div className="sticky top-[84px] z-20 -mx-4 mb-8 flex items-center justify-between gap-3 bg-cream/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-0">
        <p className="text-[13px] text-forest/70" aria-live="polite">
          <span className="font-medium text-forest">{results.length}</span> {results.length === 1 ? "product" : "products"}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => setDrawer(true)} className="serif-italic rounded-full border-[1.5px] border-forest/30 px-4 py-2 text-[15px] lg:hidden">
            Filters{activeCount ? ` (${activeCount})` : ""}
          </button>
          <label htmlFor="shop-sort" className="sr-only">
            Sort by
          </label>
          <select
            id="shop-sort"
            value={state.sort}
            onChange={(e) => setState((s) => ({ ...s, sort: e.target.value as Sort }))}
            className="rounded-full border-[1.5px] border-forest/30 bg-cream-light px-4 py-2 text-[13px] outline-none focus:border-forest"
          >
            <option value="featured">Featured</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[250px_1fr]">
        <aside className="hidden lg:block">
          <div className="sticky top-[110px]">{Filters}</div>
        </aside>

        <div>
          {/* active chips */}
          {activeCount > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {state.q && <Chip onClear={() => setState((s) => ({ ...s, q: "" }))}>“{state.q}”</Chip>}
              {state.cats.map((c) => (
                <Chip key={c} onClear={() => toggleCat(c)}>
                  {categories.find((x) => x.slug === c)?.name}
                </Chip>
              ))}
              {state.max && <Chip onClear={() => setState((s) => ({ ...s, max: null }))}>Up to {formatPrice(state.max * 100)}</Chip>}
            </div>
          )}

          {results.length === 0 ? (
            <div className="rounded-[14px] border-[1.5px] border-dashed border-forest/30 px-6 py-20 text-center">
              <p className="display text-[40px] leading-none">Nothing found</p>
              <p className="mt-2 text-[13px] text-forest/70">Try a different search or clear your filters.</p>
              <button onClick={reset} className="btn mt-6">
                Clear filters
              </button>
            </div>
          ) : (
            <motion.ul layout className="grid grid-cols-1 gap-5 min-[480px]:grid-cols-2 xl:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {results.map((p, i) => (
                  <motion.li
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 30, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                    transition={{ duration: 0.55, delay: Math.min(i, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <ProductCard product={p} priority={i < 3} tone={(["light", "sage", "butter"] as const)[i % 3]} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </div>
      </div>

      {/* mobile filter drawer */}
      <AnimatePresence>
        {drawer && (
          <div className="fixed inset-0 z-[80] lg:hidden">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-forest-deep/50" onClick={() => setDrawer(false)} />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Filters"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ duration: 0.5, ease: [0.76, 0, 0.24, 1] }}
              className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[18px] bg-cream p-5 pb-8"
              data-lenis-prevent
            >
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-[36px] leading-none">Filters</h2>
                <button onClick={() => setDrawer(false)} aria-label="Close filters" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-sage">
                  <IconClose />
                </button>
              </div>
              {Filters}
              <button onClick={() => setDrawer(false)} className="btn mt-8 w-full">
                Show {results.length} products
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Chip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <button onClick={onClear} className="group flex items-center gap-1.5 rounded-full bg-forest px-3 py-1.5 text-[12px] text-cream transition-colors hover:bg-forest-logo">
      {children}
      <IconClose width={14} className="transition-transform group-hover:rotate-90" />
    </button>
  );
}
