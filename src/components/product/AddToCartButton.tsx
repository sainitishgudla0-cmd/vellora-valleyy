"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ProductView, VariantView } from "@/data/types";
import { useCart } from "@/store/cart";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/format";
import { IconBag, IconCheck } from "@/components/ui/Icons";

/** Add-to-cart with "added" feedback state. */
export function AddToCartButton({
  product,
  variant,
  quantity = 1,
  className,
  size = "md",
  openDrawer = false,
  label = "Add to cart",
}: {
  product: ProductView;
  variant: VariantView;
  quantity?: number;
  className?: string;
  size?: "sm" | "md" | "lg";
  openDrawer?: boolean;
  label?: string;
}) {
  const add = useCart((s) => s.add);
  const { notify, openCart } = useUI();
  const [added, setAdded] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);

  const disabled = !variant.inStock;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        add(product, variant, quantity);
        setAdded(true);
        window.clearTimeout(t.current);
        t.current = window.setTimeout(() => setAdded(false), 1600);
        if (openDrawer) openCart();
        else notify(`${product.name} (${variant.label}) added to your cart`, variant.image ?? product.images.lifestyle);
      }}
      className={cn("btn", size === "sm" && "btn-sm", size === "lg" && "btn-lg", added && "btn-forest", className)}
      aria-live="polite"
    >
      <AnimatePresence mode="wait" initial={false}>
        {added ? (
          <motion.span key="ok" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -16, opacity: 0 }} className="flex items-center gap-2">
            <IconCheck width={18} /> Added
          </motion.span>
        ) : (
          <motion.span key="add" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -16, opacity: 0 }} className="flex items-center gap-2">
            <IconBag width={18} /> {disabled ? "Out of stock" : label}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
