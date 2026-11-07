export type CategorySlug =
  | "dry-fruits"
  | "nuts"
  | "dates"
  | "seeds"
  | "ready-to-cook"
  | "biscuits-cookies"
  | "chocolates-fruit";

export interface Category {
  slug: CategorySlug;
  name: string;
  short: string;
  /** one-line editorial description (no product claims) */
  blurb: string;
  image: string;
  /** optional transparent packshot used in editorial compositions */
  cutout?: string;
  accent: "forest" | "gold" | "bark" | "sage" | "butter";
}

export interface ProductImages {
  /** brochure lifestyle photograph — primary image everywhere */
  lifestyle: string;
  /** studio packshot (white background) */
  front?: string;
  back?: string;
  /** transparent packshot for layered compositions */
  cutout?: string;
  /** brand marketing creatives */
  gallery?: string[];
}

export interface VariantInput {
  sku: string;
  label: string;
  weightGrams: number;
  /** brochure MRP in rupees */
  mrp: number;
  shelfLife: string;
  hsCode: string;
  image?: string;
}

export interface ProductInput {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  primaryCategory: CategorySlug;
  categories: CategorySlug[];
  images: ProductImages;
  uses?: string[];
  note?: string;
  featured?: boolean;
  variants: VariantInput[];
}

/** Shape returned by the catalogue layer to UI components */
export interface ProductView {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  primaryCategory: CategorySlug;
  categories: CategorySlug[];
  images: ProductImages;
  uses: string[];
  note: string | null;
  featured: boolean;
  variants: VariantView[];
}

export interface VariantView {
  id: string;
  sku: string;
  label: string;
  weightGrams: number;
  /** paise */
  price: number;
  /** paise */
  mrp: number;
  shelfLife: string;
  hsCode: string;
  image: string | null;
  inStock: boolean;
}
