"use client";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { categoryMap } from "@/data/categories";
import { site } from "@/config/site";
import { cartCount, cartSubtotal, syncCartWithServer, useCart } from "@/store/cart";
import { useUI } from "@/store/ui";
import { cn, formatPrice } from "@/lib/format";
import { getLenis } from "@/components/motion/SmoothScroll";
import { IconArrowRight, IconCheck, IconClose, IconTrash } from "@/components/ui/Icons";
import { Roll } from "@/components/ui/Button";
import { QuantityStepper } from "@/components/product/QuantityStepper";
import { AddToCartButton } from "@/components/product/AddToCartButton";

/** Locks page scroll (Lenis + native) and traps focus inside `ref` while open. */
function useModal(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    getLenis()?.stop();
    document.documentElement.style.overflow = "hidden";
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus], button, a")?.focus(), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      getLenis()?.start();
      document.documentElement.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose, ref]);
}

const backdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.35 },
};

/* ───────────────────────── Cart drawer ───────────────────────── */
export function CartDrawer() {
  const { cartOpen, closeCart } = useUI();
  const { lines, setQty, remove } = useCart();
  const ref = useRef<HTMLDivElement>(null);
  useModal(cartOpen, closeCart, ref);
  useEffect(() => {
    if (cartOpen) syncCartWithServer();
  }, [cartOpen]);
  const subtotal = cartSubtotal(lines);
  const count = cartCount(lines);

  return (
    <AnimatePresence>
      {cartOpen && (
        <div className="fixed inset-0 z-[80]">
          <motion.div {...backdrop} className="absolute inset-0 bg-forest-deep/50 backdrop-blur-[2px]" onClick={closeCart} />
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Your cart"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.6, ease: [0.76, 0, 0.24, 1] }}
            className="absolute bottom-0 right-0 top-0 flex w-full max-w-[460px] flex-col bg-cream"
            data-lenis-prevent
          >
            <div className="flex items-center justify-between border-b border-forest/15 px-5 py-4">
              <h2 className="text-[38px] leading-none">
                Your cart <span className="font-mono text-[14px] font-normal normal-case text-forest/60">({count})</span>
              </h2>
              <button onClick={closeCart} aria-label="Close cart" className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-sage">
                <IconClose />
              </button>
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                <Image src="/images/brand/mark-forest.png" alt="" width={90} height={110} className="opacity-25" />
                <p className="display mt-6 text-[34px] leading-none">Your cart is empty</p>
                <p className="mt-2 text-[13px] text-forest/70">Discover dry fruits, dates, seeds and more from the valley.</p>
                <Link href="/shop" onClick={closeCart} className="btn mt-6">
                  <Roll>Start shopping</Roll>
                </Link>
              </div>
            ) : (
              <>
                <ul className="flex-1 divide-y divide-forest/10 overflow-y-auto px-5">
                  <AnimatePresence initial={false}>
                    {lines.map((l) => (
                      <motion.li
                        key={l.variantId}
                        layout
                        initial={{ opacity: 0, x: 30 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 40, height: 0, paddingTop: 0, paddingBottom: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="flex gap-4 py-4"
                      >
                        <Link href={`/product/${l.slug}`} onClick={closeCart} className="relative h-24 w-20 shrink-0 overflow-hidden rounded-[8px] bg-dough">
                          <Image src={l.image} alt="" fill sizes="80px" className="object-cover" />
                        </Link>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <Link href={`/product/${l.slug}`} onClick={closeCart} className="display block text-[22px] leading-[0.95]">
                                {l.name}
                              </Link>
                              <p className="text-[12px] text-forest/60">{l.label}</p>
                            </div>
                            <button onClick={() => remove(l.variantId)} aria-label={`Remove ${l.name}`} className="rounded-full p-1.5 text-forest/50 transition-colors hover:bg-sage hover:text-forest">
                              <IconTrash width={16} />
                            </button>
                          </div>
                          {l.unavailable && <p className="mt-1 text-[12px] text-red-700">Currently unavailable — please remove.</p>}
                          <div className="mt-auto flex items-center justify-between pt-2">
                            <QuantityStepper size="sm" value={l.quantity} onChange={(n) => setQty(l.variantId, n)} label={`Quantity of ${l.name}`} />
                            <span className="text-[15px] font-medium">{formatPrice(l.price * l.quantity)}</span>
                          </div>
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
                <div className="border-t border-forest/15 bg-cream-light px-5 pb-5 pt-4">
                  <div className="flex items-baseline justify-between">
                    <span className="eyebrow">Subtotal</span>
                    <span className="display text-[30px]">{formatPrice(subtotal)}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-forest/60">{site.delivery.note}</p>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Link href="/cart" onClick={closeCart} className="btn btn-cream border border-forest/20">
                      <Roll>View cart</Roll>
                    </Link>
                    <Link href="/checkout" onClick={closeCart} className={cn("btn", lines.some((l) => l.unavailable) && "pointer-events-none opacity-50")}>
                      <Roll>Checkout</Roll>
                    </Link>
                  </div>
                </div>
              </>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────── Quick view ───────────────────────── */
export function QuickView() {
  const { quickView: p, closeQuickView } = useUI();
  const ref = useRef<HTMLDivElement>(null);
  const [vi, setVi] = useState(0);
  const [qty, setQty] = useState(1);
  const [img, setImg] = useState(0);
  useModal(!!p, closeQuickView, ref);
  useEffect(() => {
    setVi(0);
    setQty(1);
    setImg(0);
  }, [p]);

  const variant = p?.variants[vi];
  const imgs = p
    ? ([variant?.image ?? p.images.lifestyle, p.images.front, p.images.back].filter(Boolean) as string[])
    : [];

  return (
    <AnimatePresence>
      {p && variant && (
        <div className="fixed inset-0 z-[85] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div {...backdrop} className="absolute inset-0 bg-forest-deep/55 backdrop-blur-[2px]" onClick={closeQuickView} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={`${p.name} quick view`}
            initial={{ opacity: 0, y: 60, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.98 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="relative max-h-[92vh] w-full max-w-[980px] overflow-y-auto rounded-t-[18px] bg-cream-light sm:rounded-[18px]"
            data-lenis-prevent
          >
            <button
              onClick={closeQuickView}
              aria-label="Close quick view"
              className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-cream-light/90 transition-colors hover:bg-sage"
            >
              <IconClose />
            </button>
            <div className="grid grid-cols-1 md:grid-cols-2">
              <div className="p-3">
                <div className="relative aspect-square overflow-hidden rounded-[12px] bg-white">
                  <AnimatePresence mode="wait">
                    <motion.div key={imgs[img]} initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.45 }} className="absolute inset-0">
                      <Image src={imgs[img] ?? imgs[0]} alt={p.name} fill sizes="(min-width: 768px) 480px, 100vw" className={cn(img === 0 ? "object-cover" : "object-contain p-6")} />
                    </motion.div>
                  </AnimatePresence>
                </div>
                {imgs.length > 1 && (
                  <div className="mt-2 flex gap-2">
                    {imgs.map((s, i) => (
                      <button
                        key={s}
                        onClick={() => setImg(i)}
                        aria-label={`Show image ${i + 1}`}
                        className={cn("relative h-16 w-16 overflow-hidden rounded-[8px] border-2 bg-white transition-colors", i === img ? "border-forest" : "border-transparent")}
                      >
                        <Image src={s} alt="" fill sizes="64px" className={i === 0 ? "object-cover" : "object-contain p-1"} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col p-6 pt-3 md:pt-10">
                <span className="eyebrow text-leaf">{categoryMap[p.primaryCategory]?.name}</span>
                <h2 className="mt-2 text-[clamp(2.4rem,4.5vw,3.6rem)] leading-[0.88]">{p.name}</h2>
                <p className="script mt-1 text-[26px] text-leaf">{p.tagline}</p>
                <p className="mt-3 text-[14px] text-forest/80">{p.description}</p>
                {p.variants.length > 1 && (
                  <div className="mt-5">
                    <span className="label">Pack size</span>
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pack size">
                      {p.variants.map((v, i) => (
                        <button
                          key={v.id}
                          role="radio"
                          aria-checked={i === vi}
                          onClick={() => {
                            setVi(i);
                            setImg(0);
                          }}
                          className={cn("rounded-full border-[1.5px] px-4 py-2 text-[13px] transition-colors", i === vi ? "border-forest bg-forest text-cream" : "border-forest/30 hover:border-forest")}
                        >
                          {v.label} · {formatPrice(v.price)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-5 flex items-baseline gap-3">
                  <span className="display text-[44px] leading-none">{formatPrice(variant.price)}</span>
                  <span className="text-[12px] text-forest/60">{variant.price === variant.mrp ? "MRP, incl. of all taxes" : `MRP ${formatPrice(variant.mrp)}`}</span>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <QuantityStepper value={qty} onChange={setQty} />
                  <AddToCartButton product={p} variant={variant} quantity={qty} className="flex-1" />
                </div>
                <Link href={`/product/${p.slug}`} onClick={closeQuickView} className="group mt-5 inline-flex items-center gap-2 self-start text-[13px]">
                  <span className="link-underline">View full details</span>
                  <IconArrowRight width={16} className="transition-transform group-hover:translate-x-1" />
                </Link>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────── Toast ───────────────────────── */
export function Toast() {
  const toast = useUI((s) => s.toast);
  const openCart = useUI((s) => s.openCart);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex justify-center px-4 sm:bottom-6 sm:justify-end sm:px-6" aria-live="polite">
      <AnimatePresence>
        {visible && toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 30, rotate: -2 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto flex w-full max-w-[380px] items-center gap-3 rounded-[12px] bg-forest p-2.5 pr-3 text-cream shadow-lift"
          >
            {toast.image && (
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[8px]">
                <Image src={toast.image} alt="" fill sizes="48px" className="object-cover" />
              </span>
            )}
            <span className="flex-1 text-[12.5px] leading-snug">
              <IconCheck width={14} className="mr-1 inline text-gold" />
              {toast.message}
            </span>
            <button
              onClick={() => {
                setVisible(false);
                openCart();
              }}
              className="serif-italic shrink-0 rounded-full bg-gold px-3 py-1.5 text-[14px] text-forest-deep"
            >
              View cart
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
