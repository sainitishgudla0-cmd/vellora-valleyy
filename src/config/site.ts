/**
 * Central, editable brand + business configuration.
 * All contact details below are taken from the Velora Valley brochure (back cover).
 * Update them here — every page, the footer and structured data read from this file.
 */
export const site = {
  name: "Velora Valley",
  company: "Anantha Food Products",
  tagline: "Nature's Finest. Delivered to Your Table.",
  description:
    "Premium dry fruits, nuts, dates, seeds, ready-to-cook foods, biscuits and fruit products from Velora Valley by Anantha Food Products, Anantapur.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  /** Brochure cover line describing the business */
  manufacturerLine:
    "Manufacturers, processors and packers of ready-to-cook foods (chapati, parota), ragi malt, dry fruits, jams, tutti frutti, candied karonda cherry, all types of dates, mixed jellies, biscuits, chocolates and all types of seeds.",
  address: {
    line1: "2-29-1 KM Colony, JNTU Road",
    city: "Anantapur",
    state: "Andhra Pradesh",
    pincode: "515002",
    country: "India",
  },
  phones: ["+91 7032405058", "+91 8978832289", "+91 9381411247"],
  email: "ananthafoodproductsco@gmail.com",
  website: "www.veloravalley.com",
  fssaiLicense: "10126013000012",
  /** Brochure lists "@veloravalley" on Facebook, Instagram and X; verify the URLs before launch. */
  social: {
    handle: "@veloravalley",
    facebook: "https://www.facebook.com/veloravalley",
    instagram: "https://www.instagram.com/veloravalley",
    x: "https://x.com/veloravalley",
  },
  currency: "INR",
  /**
   * Delivery fee in paise added to every order. Brochure does not specify
   * delivery charges, so this defaults to 0 and the note explains how charges
   * are confirmed. Change both when a delivery policy is decided.
   */
  delivery: {
    fee: 0,
    note: "Any delivery charges for your pincode will be confirmed by our team before dispatch.",
  },
  /** Prices are initialised from brochure MRPs and can be edited in the admin dashboard. */
  priceNote: "Prices shown are brochure MRPs (inclusive of all taxes) and may be updated.",
  /** Pay-on-delivery order requests. Set to false to disable. */
  allowCashOnDelivery: true,
} as const;

export const nav = [
  { label: "Home", href: "/" },
  {
    label: "Shop",
    href: "/shop",
    menu: "shop" as const,
  },
  { label: "Dry Fruits", href: "/shop?category=dry-fruits", menu: "dry-fruits" as const },
  { label: "Nuts & Seeds", href: "/shop?category=nuts,seeds", menu: "nuts-seeds" as const },
  { label: "Dates", href: "/shop?category=dates", menu: "dates" as const },
  { label: "Our Story", href: "/our-story" },
  { label: "Quality", href: "/quality" },
  { label: "Contact", href: "/contact" },
];

export type NavItem = (typeof nav)[number];

/**
 * Testimonials. The brochure contains no customer reviews, so this list is empty.
 * Add real, approved quotes here and the testimonial section renders them automatically:
 *   { quote: "...", name: "First L.", context: "Hyderabad", rating: 5 }
 */
export const testimonials: { quote: string; name: string; context?: string; rating?: number }[] = [];
