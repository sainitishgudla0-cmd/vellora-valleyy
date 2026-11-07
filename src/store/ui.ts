"use client";
import { create } from "zustand";
import type { ProductView } from "@/data/types";

interface UIState {
  cartOpen: boolean;
  menuOpen: boolean;
  quickView: ProductView | null;
  toast: { id: number; message: string; image?: string } | null;
  openCart: () => void;
  closeCart: () => void;
  setMenu: (open: boolean) => void;
  openQuickView: (p: ProductView) => void;
  closeQuickView: () => void;
  notify: (message: string, image?: string) => void;
}

export const useUI = create<UIState>((set) => ({
  cartOpen: false,
  menuOpen: false,
  quickView: null,
  toast: null,
  openCart: () => set({ cartOpen: true, menuOpen: false }),
  closeCart: () => set({ cartOpen: false }),
  setMenu: (menuOpen) => set({ menuOpen }),
  openQuickView: (quickView) => set({ quickView }),
  closeQuickView: () => set({ quickView: null }),
  notify: (message, image) => set({ toast: { id: Date.now(), message, image } }),
}));
