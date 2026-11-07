const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inrPrecise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

/** Format paise as rupees. */
export function formatPrice(paise: number) {
  return paise % 100 === 0 ? inr.format(paise / 100) : inrPrecise.format(paise / 100);
}

export const rupeesToPaise = (r: number) => Math.round(r * 100);

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
