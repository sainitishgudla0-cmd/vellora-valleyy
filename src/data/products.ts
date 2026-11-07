/**
 * Velora Valley product catalogue — transcribed from the brochure
 * ("Brochure - Velora Valley.pdf", pages 3–11).
 *
 * - MRP, barcode, shelf life and HS code are copied as printed in the brochure.
 * - MRPs seed the selling price; prices are editable afterwards in /admin.
 * - Descriptions are deliberately factual. Do NOT add ingredients, nutrition,
 *   certifications or health claims here unless they are approved by the brand.
 *
 * After editing this file run `npm run db:seed` to sync the database.
 */
import type { ProductImages, ProductInput } from "./types";

const P = (slug: string, f: string) => `/images/products/${slug}/${f}`;

function images(slug: string, opts: { packshot?: boolean; gallery?: number } = {}): ProductImages {
  const base: ProductImages = { lifestyle: P(slug, "lifestyle.webp") };
  if (opts.packshot) {
    base.front = P(slug, "front.webp");
    base.back = P(slug, "back.webp");
    base.cutout = P(slug, "cutout.webp");
  }
  if (opts.gallery) base.gallery = Array.from({ length: opts.gallery }, (_, i) => P(slug, `gallery-${i + 1}.webp`));
  return base;
}

const SIX_MONTHS_PKG = "6 months from packaging date";

export const products: ProductInput[] = [
  // ─── Nuts & dry fruits ──────────────────────────────────────────────
  {
    slug: "premium-cashews",
    name: "Premium Cashews",
    tagline: "The everyday favourite",
    description:
      "Velora Valley Premium Cashews, packed in a 250g pouch. Enjoy them as they are, or use them in sweets, gravies, pulao and festive cooking.",
    primaryCategory: "nuts",
    categories: ["nuts", "dry-fruits"],
    images: images("premium-cashews", { packshot: true, gallery: 3 }),
    uses: ["Snack straight from the pack", "Garnish for kheer, halwa and payasam", "Grind into rich gravies"],
    featured: true,
    variants: [{ sku: "8908029706182", label: "250g", weightGrams: 250, mrp: 400, shelfLife: SIX_MONTHS_PKG, hsCode: "08013220" }],
  },
  {
    slug: "california-almonds",
    name: "California Almonds",
    tagline: "A pantry essential",
    description:
      "Velora Valley California Almonds in a 250g pouch. Soak them overnight, add them to breakfast bowls, or keep a handful close for the day.",
    primaryCategory: "nuts",
    categories: ["nuts", "dry-fruits"],
    images: images("california-almonds", { packshot: true, gallery: 3 }),
    uses: ["Soak overnight for the morning", "Top cereal, oats and smoothies", "Bake into cookies and cakes"],
    featured: true,
    variants: [{ sku: "8908029706168", label: "250g", weightGrams: 250, mrp: 370, shelfLife: SIX_MONTHS_PKG, hsCode: "080212" }],
  },
  {
    slug: "salted-roasted-pistachios",
    name: "Salted & Roasted Pistachios",
    tagline: "Roasted, salted, irresistible",
    description:
      "Velora Valley Salted and Roasted Pistachios in a 250g pouch — an easy snack for tea time, travel and get-togethers.",
    primaryCategory: "nuts",
    categories: ["nuts", "dry-fruits"],
    images: images("salted-roasted-pistachios", { packshot: true, gallery: 3 }),
    uses: ["Tea-time snacking", "Share at get-togethers", "Gift alongside sweets"],
    featured: true,
    variants: [{ sku: "8908029706175", label: "250g", weightGrams: 250, mrp: 450, shelfLife: SIX_MONTHS_PKG, hsCode: "08025200" }],
  },
  {
    slug: "premium-black-raisins",
    name: "Premium Black Raisins",
    tagline: "Naturally sweet bites",
    description:
      "Velora Valley Premium Black Raisins in a 250g pouch. Add them to breakfast, desserts and baking, or enjoy a few on their own.",
    primaryCategory: "dry-fruits",
    categories: ["dry-fruits"],
    images: images("premium-black-raisins", { packshot: true, gallery: 2 }),
    uses: ["Stir into kheer and sheera", "Add to granola and salads", "Bake into breads and cakes"],
    featured: true,
    variants: [{ sku: "8908029706199", label: "250g", weightGrams: 250, mrp: 300, shelfLife: SIX_MONTHS_PKG, hsCode: "08062010" }],
  },

  // ─── Dates ──────────────────────────────────────────────────────────
  {
    slug: "safawi-dates",
    name: "Safawi Dates",
    tagline: "Our premium gift box",
    description:
      "Velora Valley Safawi Dates in a 500g premium gift box — a thoughtful choice for festivals, guests and celebrations.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("safawi-dates", { packshot: true, gallery: 3 }),
    uses: ["Serve to guests", "Gift during festivals", "Pair with nuts on a platter"],
    featured: true,
    variants: [{ sku: "8908029706052", label: "500g", weightGrams: 500, mrp: 550, shelfLife: "18 months from packaging date", hsCode: "08041020" }],
  },
  {
    slug: "kimia-dates",
    name: "Kimia Dates",
    tagline: "Soft, dark and rich",
    description:
      "Velora Valley Kimia Dates, available in three pack sizes. A soft, dark date that is lovely on its own or alongside a cup of tea.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("kimia-dates", { packshot: true, gallery: 3 }),
    uses: ["Enjoy with tea or milk", "Blend into date shakes", "Stuff with almonds"],
    featured: true,
    variants: [
      { sku: "8908029706021", label: "500g", weightGrams: 500, mrp: 420, shelfLife: "18 months from packaging date", hsCode: "08041020" },
      { sku: "8908029706038", label: "400g", weightGrams: 400, mrp: 350, shelfLife: "18 months from packaging date", hsCode: "08041020", image: P("kimia-dates", "lifestyle-400g.webp") },
      { sku: "8908029706045", label: "250g", weightGrams: 250, mrp: 210, shelfLife: "18 months from packaging date", hsCode: "08041020", image: P("kimia-dates", "lifestyle-250g.webp") },
    ],
  },
  {
    slug: "arabian-premium-seedless-dates",
    name: "Arabian Premium Seedless Dates",
    tagline: "Seedless, in a keep-fresh tray",
    description: "Velora Valley Arabian Premium Seedless Dates in a 500g tray pack. Ready to snack, chop or blend — no pitting needed.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("arabian-premium-seedless-dates", { packshot: true, gallery: 2 }),
    uses: ["Chop into desserts and laddoos", "Blend into smoothies", "Snack on the go"],
    variants: [{ sku: "8908029706069", label: "500g", weightGrams: 500, mrp: 200, shelfLife: SIX_MONTHS_PKG, hsCode: "08041020" }],
  },
  {
    slug: "arabian-seeded-dates",
    name: "Arabian Seeded Dates",
    tagline: "The family-size pack",
    description: "Velora Valley Arabian Seeded Dates in a 1kg pouch — a generous family pack for everyday enjoyment.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("arabian-seeded-dates", { packshot: true, gallery: 2 }),
    uses: ["Everyday family snacking", "Make date syrup or chutney", "Serve during festivals"],
    variants: [{ sku: "8908029706083", label: "1kg", weightGrams: 1000, mrp: 220, shelfLife: SIX_MONTHS_PKG, hsCode: "08041020" }],
  },
  {
    slug: "arabian-dates",
    name: "Arabian Dates",
    tagline: "Pocket-friendly pouch",
    description: "Velora Valley Arabian Dates in a 250g pouch.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("arabian-dates"),
    note: "Listed in the brochure as a \"Buy One Get One\" pack. Please confirm current offers with our team.",
    variants: [{ sku: "8908029706076", label: "250g", weightGrams: 250, mrp: 120, shelfLife: SIX_MONTHS_PKG, hsCode: "08041020" }],
  },
  {
    slug: "seedless-dates",
    name: "Arabian Seedless Dates",
    tagline: "Seedless convenience",
    description: "Velora Valley Arabian Seedless Dates in a 500g pack.",
    primaryCategory: "dates",
    categories: ["dates"],
    images: images("seedless-dates"),
    variants: [{ sku: "8908029706410", label: "500g", weightGrams: 500, mrp: 140, shelfLife: SIX_MONTHS_PKG, hsCode: "08041020" }],
  },

  // ─── Seeds ──────────────────────────────────────────────────────────
  {
    slug: "roasted-super-seed-mix",
    name: "Roasted Super Seed Mix",
    tagline: "Many seeds, one pouch",
    description: "Velora Valley Roasted Super Seeds Mix in a 200g pouch. Sprinkle it over salads, curd, poha or breakfast bowls.",
    primaryCategory: "seeds",
    categories: ["seeds"],
    images: images("roasted-super-seed-mix", { packshot: true, gallery: 2 }),
    uses: ["Sprinkle over salads and curd", "Top poha, upma and oats", "Snack by the spoonful"],
    featured: true,
    variants: [{ sku: "8908029706250", label: "200g", weightGrams: 200, mrp: 250, shelfLife: SIX_MONTHS_PKG, hsCode: "20081920" }],
  },
  seed("flax-seeds", "Flax Seeds", "Harvest fresh", [["8908029706366", 250, 60]], "12040090", ["Add to rotis and parathas", "Blend into smoothies"]),
  seed("chia-seeds", "Chia Seeds", "Tiny seeds, big on texture", [["8908029706380", 100, 50], ["8908029706373", 250, 120]], "12079990", ["Soak for chia pudding", "Stir into lemonade"]),
  seed("pumpkin-seeds", "Pumpkin Seeds", "Harvest fresh", [["8908029706298", 100, 60], ["8908029706281", 250, 160]], "12129990", ["Toast as a snack", "Top soups and salads"]),
  seed("sunflower-seeds", "Sunflower Seeds", "Harvest fresh", [["8908029706311", 100, 50], ["8908029706304", 250, 100]], "12060010", ["Mix into trail mix", "Bake into breads"]),
  seed("sabja-seeds", "Sabja Seeds", "A summer classic", [["8908029706403", 100, 50], ["8908029706397", 250, 120]], "12119092", ["Soak for falooda and sherbet", "Add to lemonade"]),
  seed("muskmelon-seeds", "Muskmelon Seeds", "Harvest fresh", [["8908029706359", 100, 100], ["8908029706342", 250, 250]], "12077090", ["Garnish sweets", "Add to thandai"]),
  seed("watermelon-seeds", "Watermelon Seeds", "Harvest fresh", [["8908029706335", 100, 80], ["8908029706328", 250, 200]], "12075010", ["Roast as a snack", "Garnish laddoos"]),

  // ─── Ready-to-cook ──────────────────────────────────────────────────
  {
    slug: "whole-wheat-chapati",
    name: "Whole Wheat Chapati",
    tagline: "10 chapatis, ready to cook",
    description: "Velora Valley Whole Wheat Chapati — a pack of 10 ready-to-cook chapatis (400g). Warm on a tawa and serve.",
    primaryCategory: "ready-to-cook",
    categories: ["ready-to-cook"],
    images: images("whole-wheat-chapati"),
    uses: ["Warm on a hot tawa", "Serve with curry or dal", "Roll into wraps"],
    note: "Short shelf life (7 days from manufacturing). Availability may depend on your location.",
    variants: [{ sku: "8908029706007", label: "10 pieces (400g)", weightGrams: 400, mrp: 60, shelfLife: "7 days from manufacturing date", hsCode: "19059090" }],
  },
  {
    slug: "malabar-paratha",
    name: "Malabar Paratha",
    tagline: "Flaky, layered, ready to cook",
    description: "Velora Valley Malabar Paratha — a pack of 6 ready-to-cook parathas (480g). Cook on a tawa until golden and serve hot.",
    primaryCategory: "ready-to-cook",
    categories: ["ready-to-cook"],
    images: images("malabar-paratha"),
    uses: ["Cook on a tawa until golden", "Pair with kurma or salna", "Make kothu paratha"],
    note: "Short shelf life (7 days from manufacturing). Availability may depend on your location.",
    variants: [{ sku: "8908029706014", label: "6 pieces (480g)", weightGrams: 480, mrp: 70, shelfLife: "7 days from manufacturing date", hsCode: "19059090" }],
  },
  {
    slug: "ragi-malt",
    name: "Ragi Malt",
    tagline: "A traditional drink mix",
    description: "Velora Valley Ragi Malt in a 500g box. Prepare it with milk or water following the instructions on the pack.",
    primaryCategory: "ready-to-cook",
    categories: ["ready-to-cook"],
    images: images("ragi-malt"),
    uses: ["Prepare with warm milk", "Make a quick morning drink"],
    variants: [{ sku: "8908029706243", label: "500g", weightGrams: 500, mrp: 150, shelfLife: "3 months from manufacturing date", hsCode: "19019090" }],
  },

  // ─── Biscuits & cookies ─────────────────────────────────────────────
  {
    slug: "fruit-and-nut-cookies",
    name: "Fruit & Nut Cookies",
    tagline: "Buttery tea-time cookies",
    description: "Velora Valley Fruit and Nut Cookies in a 250g box — made for chai, coffee and sharing.",
    primaryCategory: "biscuits-cookies",
    categories: ["biscuits-cookies"],
    images: images("fruit-and-nut-cookies"),
    uses: ["Pair with chai or coffee", "Pack for school and office"],
    variants: [{ sku: "8908029706212", label: "250g", weightGrams: 250, mrp: 120, shelfLife: "3 months from packaging date", hsCode: "19053100" }],
  },
  {
    slug: "osmania-biscuits",
    name: "Osmania Biscuits",
    tagline: "A Hyderabadi classic",
    description: "Velora Valley Osmania Biscuits in a 250g box — the sweet-and-salty classic that belongs next to Irani chai.",
    primaryCategory: "biscuits-cookies",
    categories: ["biscuits-cookies"],
    images: images("osmania-biscuits"),
    uses: ["Dunk in Irani chai", "Serve to guests"],
    variants: [{ sku: "8908029706229", label: "250g", weightGrams: 250, mrp: 100, shelfLife: "3 months from packaging date", hsCode: "19053100" }],
  },
  {
    slug: "ragi-biscuits",
    name: "Ragi Biscuits",
    tagline: "Made with ragi",
    description: "Velora Valley Ragi Biscuits in a 250g box.",
    primaryCategory: "biscuits-cookies",
    categories: ["biscuits-cookies"],
    images: images("ragi-biscuits"),
    uses: ["Tea-time snack", "Lunchbox treat"],
    variants: [{ sku: "8908029706236", label: "250g", weightGrams: 250, mrp: 100, shelfLife: "3 months from packaging date", hsCode: "19053100" }],
  },

  // ─── Chocolates & fruit products ────────────────────────────────────
  {
    slug: "dates-chocolate",
    name: "Dates Chocolate",
    tagline: "Dates, dipped in chocolate",
    description: "Velora Valley Dates Chocolate in a 250g window box — a giftable treat for festivals and celebrations.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("dates-chocolate"),
    uses: ["Gift for festivals", "Serve after dinner"],
    featured: true,
    variants: [{ sku: "8908029706267", label: "250g", weightGrams: 250, mrp: 150, shelfLife: SIX_MONTHS_PKG, hsCode: "18069090" }],
  },
  {
    slug: "dark-chocolate",
    name: "Dark Chocolate",
    tagline: "Bite-sized squares",
    description: "Velora Valley's Dark Chocolate in a 250g window box.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("dark-chocolate"),
    uses: ["Share after dinner", "Melt over desserts"],
    variants: [{ sku: "8908029706274", label: "250g", weightGrams: 250, mrp: 150, shelfLife: SIX_MONTHS_PKG, hsCode: "18069090" }],
  },
  {
    slug: "mixed-fruit-jam",
    name: "Mixed Fruit Jam",
    tagline: "Breakfast, sorted",
    description: "Velora Valley Mixed Fruit Jam in a 200g tub. Spread it on toast, rotis and sandwiches.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("mixed-fruit-jam"),
    uses: ["Spread on toast", "Roll into chapati for kids", "Fill tarts and cakes"],
    variants: [{ sku: "8908029706113", label: "200g", weightGrams: 200, mrp: 50, shelfLife: SIX_MONTHS_PKG, hsCode: "20079990" }],
  },
  {
    slug: "mixed-jelly-cubes",
    name: "Mixed Jelly Cubes",
    tagline: "Colourful, chewy cubes",
    description: "Velora Valley Mixed Jelly Cubes in a 250g tray.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("mixed-jelly-cubes"),
    uses: ["Decorate cakes and desserts", "Party treat"],
    variants: [{ sku: "8908029706106", label: "250g", weightGrams: 250, mrp: 80, shelfLife: SIX_MONTHS_PKG, hsCode: "20079990" }],
  },
  {
    slug: "tutti-fruity",
    name: "Tutti Fruity",
    tagline: "For baking and desserts",
    description: "Velora Valley Tutti Fruity, available in 100g and 200g tubs. Fold into cakes, buns, cookies and ice creams.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("tutti-fruity"),
    uses: ["Bake into tutti frutti cake", "Top ice cream and falooda"],
    variants: [
      { sku: "8908029706120", label: "100g", weightGrams: 100, mrp: 40, shelfLife: SIX_MONTHS_PKG, hsCode: "20060000" },
      { sku: "8908029706137", label: "200g", weightGrams: 200, mrp: 70, shelfLife: SIX_MONTHS_PKG, hsCode: "20060000", image: P("tutti-fruity", "lifestyle-200g.webp") },
    ],
  },
  {
    slug: "candied-karonda-cherry",
    name: "Candied Karonda Cherry",
    tagline: "Ideal for baking & desserts",
    description: "Velora Valley Premium Candied Karonda Cherry, available in 100g and 200g tubs. Use it to decorate cakes, sweets and desserts.",
    primaryCategory: "chocolates-fruit",
    categories: ["chocolates-fruit"],
    images: images("candied-karonda-cherry"),
    uses: ["Decorate cakes and pastries", "Top sundaes and custards"],
    variants: [
      { sku: "8908029706144", label: "100g", weightGrams: 100, mrp: 40, shelfLife: SIX_MONTHS_PKG, hsCode: "20060000" },
      { sku: "8908029706151", label: "200g", weightGrams: 200, mrp: 70, shelfLife: SIX_MONTHS_PKG, hsCode: "20060000", image: P("candied-karonda-cherry", "lifestyle-200g.webp") },
    ],
  },
];

function seed(
  slug: string,
  name: string,
  tagline: string,
  packs: [sku: string, grams: number, mrp: number][],
  hsCode: string,
  uses: string[],
): ProductInput {
  return {
    slug,
    name,
    tagline,
    description: `Velora Valley ${name}, from our "Harvest Fresh" seed range, available in ${packs.map((p) => `${p[1]}g`).join(" and ")} pack${packs.length > 1 ? "s" : ""}.`,
    primaryCategory: "seeds",
    categories: ["seeds"],
    images: images(slug),
    uses,
    variants: packs.map(([sku, grams, mrp]) => ({ sku, label: `${grams}g`, weightGrams: grams, mrp, shelfLife: SIX_MONTHS_PKG, hsCode })),
  };
}
