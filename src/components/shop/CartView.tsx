"use client";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { site } from "@/config/site";
import { cartCount, cartSubtotal, syncCartWithServer, useCart, useCartHydrated } from "@/store/cart";
import { formatPrice } from "@/lib/format";
import { QuantityStepper } from "@/components/product/QuantityStepper";
import { Frame } from "@/components/ui/Ornaments";
import { Roll } from "@/components/ui/Button";
import { IconArrowRight, IconTrash } from "@/components/ui/Icons";

export function CartView() {
  const { lines, setQty, remove, clear } = useCart();
  const hydrated = useCartHydrated();
  useEffect(() => {
    if (hydrated) syncCartWithServer();
  }, [hydrated]);

  if (!hydrated) return <div className="container-site h-[40vh]" aria-busy="true" />;

  if (!lines.length)
    return (
      <div className="container-site pb-24">
        <div className="rounded-[18px] border-[1.5px] border-dashed border-forest/30 px-6 py-20 text-center">
          <p className="display text-[44px] leading-none">Your cart is empty</p>
          <p className="mt-3 text-[13.5px] text-forest/70">Fill it with dry fruits, dates, seeds and more from Velora Valley.</p>
          <Link href="/shop" className="btn btn-lg mt-8">
            <Roll>Explore our products</Roll>
          </Link>
        </div>
      </div>
    );

  const subtotal = cartSubtotal(lines);
  const blocked = lines.some((l) => l.unavailable);

  return (
    <div className="container-site grid grid-cols-1 gap-10 pb-24 lg:grid-cols-[1fr_400px]">
      <div>
        <div className="hidden grid-cols-[1fr_140px_120px_40px] gap-4 border-b border-forest/20 pb-3 text-[11px] uppercase tracking-[0.16em] text-forest/60 md:grid">
          <span>Product</span>
          <span>Quantity</span>
          <span className="text-right">Total</span>
          <span />
        </div>
        <ul>
          <AnimatePresence initial={false}>
            {lines.map((l) => (
              <motion.li
                key={l.variantId}
                layout
                exit={{ opacity: 0, x: -30, transition: { duration: 0.25 } }}
                className="grid grid-cols-[80px_1fr] gap-4 border-b border-forest/15 py-5 md:grid-cols-[1fr_140px_120px_40px] md:items-center"
              >
                <div className="contents md:flex md:items-center md:gap-4">
                  <Link href={`/product/${l.slug}`} className="relative row-span-2 h-[96px] w-[80px] shrink-0 overflow-hidden rounded-[10px] bg-dough md:h-[110px] md:w-[92px]">
                    <Image src={l.image} alt="" fill sizes="92px" className="object-cover transition-transform duration-700 hover:scale-110" />
                  </Link>
                  <div>
                    <Link href={`/product/${l.slug}`} className="display text-[26px] leading-[0.95] hover:text-leaf">
                      {l.name}
                    </Link>
                    <p className="text-[12.5px] text-forest/60">
                      {l.label} · {formatPrice(l.price)} each
                    </p>
                    {l.unavailable && <p className="mt-1 text-[12px] text-red-700">This item is currently unavailable. Please remove it to continue.</p>}
                  </div>
                </div>
                <div className="col-start-2 flex items-center justify-between gap-3 md:col-auto md:block">
                  <QuantityStepper size="sm" value={l.quantity} onChange={(n) => setQty(l.variantId, n)} label={`Quantity of ${l.name}`} />
                  <span className="font-medium md:hidden">{formatPrice(l.price * l.quantity)}</span>
                </div>
                <span className="hidden text-right text-[15px] font-medium md:block">{formatPrice(l.price * l.quantity)}</span>
                <button
                  onClick={() => remove(l.variantId)}
                  aria-label={`Remove ${l.name}`}
                  className="col-start-2 justify-self-start rounded-full p-2 text-[12px] text-forest/60 transition-colors hover:bg-sage hover:text-forest md:col-auto md:justify-self-end"
                >
                  <IconTrash width={18} />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <div className="mt-5 flex flex-wrap justify-between gap-3">
          <Link href="/shop" className="link-underline text-[13px]">
            ← Continue shopping
          </Link>
          <button onClick={() => window.confirm("Remove all items from your cart?") && clear()} className="link-underline text-[13px] text-forest/60">
            Clear cart
          </button>
        </div>
      </div>

      <aside className="lg:sticky lg:top-[100px] lg:self-start">
        <Frame tone="sage" n={20} innerClassName="p-6">
          <h2 className="text-[36px] leading-none">Order summary</h2>
          <dl className="mt-5 space-y-2 text-[13.5px]">
            <div className="flex justify-between">
              <dt>Items ({cartCount(lines)})</dt>
              <dd>{formatPrice(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Delivery</dt>
              <dd>{site.delivery.fee > 0 ? formatPrice(site.delivery.fee) : "To be confirmed"}</dd>
            </div>
            <div className="flex items-baseline justify-between border-t-[1.5px] border-dashed border-forest/30 pt-3">
              <dt className="eyebrow">Total</dt>
              <dd className="display text-[36px] leading-none">{formatPrice(subtotal + site.delivery.fee)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] leading-snug text-forest/65">
            {site.delivery.note} {site.priceNote}
          </p>
          <Link href="/checkout" aria-disabled={blocked} className={`btn btn-lg mt-6 w-full ${blocked ? "pointer-events-none opacity-50" : ""}`}>
            <Roll>Proceed to checkout</Roll>
            <IconArrowRight width={18} />
          </Link>
        </Frame>
      </aside>
    </div>
  );
}
