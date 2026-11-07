import type { Category, CategorySlug } from "./types";

const img = (slug: string, file = "lifestyle.webp") => `/images/products/${slug}/${file}`;

export const categories: Category[] = [
  {
    slug: "dry-fruits",
    name: "Premium Dry Fruits",
    short: "Dry Fruits",
    blurb: "Cashews, almonds, pistachios and black raisins — the everyday staples of an Indian pantry, packed with care.",
    image: img("premium-cashews"),
    cutout: img("premium-black-raisins", "cutout.webp"),
    accent: "gold",
  },
  {
    slug: "nuts",
    name: "Nuts",
    short: "Nuts",
    blurb: "Premium cashews, California almonds and salted, roasted pistachios for snacking, sweets and gifting.",
    image: img("salted-roasted-pistachios"),
    cutout: img("california-almonds", "cutout.webp"),
    accent: "forest",
  },
  {
    slug: "dates",
    name: "Dates",
    short: "Dates",
    blurb: "Safawi, Kimia and Arabian dates — seeded and seedless — in pouches, trays and gift boxes.",
    image: img("safawi-dates"),
    cutout: img("kimia-dates", "cutout.webp"),
    accent: "bark",
  },
  {
    slug: "seeds",
    name: "Seeds",
    short: "Seeds",
    blurb: "Flax, chia, pumpkin, sunflower, sabja, muskmelon and watermelon seeds, plus our roasted super seed mix.",
    image: img("roasted-super-seed-mix"),
    accent: "sage",
  },
  {
    slug: "ready-to-cook",
    name: "Ready-to-Cook Foods",
    short: "Ready-to-Cook",
    blurb: "Whole wheat chapati, Malabar paratha and ragi malt — simple, home-style staples made quick.",
    image: img("malabar-paratha"),
    accent: "butter",
  },
  {
    slug: "biscuits-cookies",
    name: "Biscuits & Cookies",
    short: "Biscuits",
    blurb: "Fruit and nut cookies, classic Osmania biscuits and ragi biscuits for every chai break.",
    image: img("osmania-biscuits"),
    accent: "gold",
  },
  {
    slug: "chocolates-fruit",
    name: "Chocolates & Fruit Products",
    short: "Chocolates & Fruit",
    blurb: "Dates chocolate, dark chocolate, mixed fruit jam, jelly cubes, tutti fruity and candied karonda cherry.",
    image: img("dates-chocolate"),
    accent: "bark",
  },
];

export const categoryMap = Object.fromEntries(categories.map((c) => [c.slug, c])) as Record<CategorySlug, Category>;

export const isCategorySlug = (s: string): s is CategorySlug => s in categoryMap;
