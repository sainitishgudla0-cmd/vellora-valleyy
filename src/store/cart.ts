"use client";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ProductView, VariantView } from "@/data/types";

export interface CartLine {
  variantId: string;
  slug: string;
  name: string;
  label: string;
  /** paise — display only; the server always recalculates */
  price: number;
  image: string;
  quantity: number;
  unavailable?: boolean;
}

interface CartState {
  lines: CartLine[];
  add: (p: ProductView, v: VariantView, qty?: number) => void;
  setQty: (variantId: string, qty: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
  sync: (updates: { id: string; price: number; available: boolean }[]) => void;
}

export const MAX_QTY = 50;

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      add: (p, v, qty = 1) =>
        set((s) => {
          const existing = s.lines.find((l) => l.variantId === v.id);
          if (existing) {
            return {
              lines: s.lines.map((l) => (l.variantId === v.id ? { ...l, quantity: Math.min(MAX_QTY, l.quantity + qty) } : l)),
            };
          }
          return {
            lines: [
              ...s.lines,
              {
                variantId: v.id,
                slug: p.slug,
                name: p.name,
                label: v.label,
                price: v.price,
                image: v.image ?? p.images.lifestyle,
                quantity: Math.min(MAX_QTY, qty),
              },
            ],
          };
        }),
      setQty: (variantId, qty) =>
        set((s) => ({
          lines: qty <= 0 ? s.lines.filter((l) => l.variantId !== variantId) : s.lines.map((l) => (l.variantId === variantId ? { ...l, quantity: Math.min(MAX_QTY, qty) } : l)),
        })),
      remove: (variantId) => set((s) => ({ lines: s.lines.filter((l) => l.variantId !== variantId) })),
      clear: () => set({ lines: [] }),
      sync: (updates) =>
        set((s) => ({
          lines: s.lines.map((l) => {
            const u = updates.find((x) => x.id === l.variantId);
            return u ? { ...l, price: u.price, unavailable: !u.available } : { ...l, unavailable: true };
          }),
        })),
    }),
    {
      name: "velora-cart-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lines: s.lines }),
    },
  ),
);

/** True once the persisted cart has been read from localStorage (avoids SSR/client mismatches). */
export function useCartHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(useCart.persist.hasHydrated());
    return useCart.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

export const cartCount = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity, 0);
export const cartSubtotal = (lines: CartLine[]) => lines.filter((l) => !l.unavailable).reduce((n, l) => n + l.price * l.quantity, 0);

/** Fetch current server prices for the cart and update local lines. */
export async function syncCartWithServer() {
  const { lines, sync } = useCart.getState();
  if (!lines.length) return;
  try {
    const res = await fetch("/api/cart/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantIds: lines.map((l) => l.variantId) }),
    });
    if (res.ok) sync((await res.json()).variants);
  } catch {
    /* offline — keep local snapshot */
  }
}
