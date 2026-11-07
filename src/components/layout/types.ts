import type { CategorySlug } from "@/data/types";

/** Lightweight product summary used by navigation menus. */
export interface MenuProduct {
  slug: string;
  name: string;
  image: string;
  categories: CategorySlug[];
  fromPrice: number;
}
