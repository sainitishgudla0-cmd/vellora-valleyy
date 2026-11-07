import { z } from "zod";

const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .refine((s) => /^(\+91)?[6-9]\d{9}$/.test(s), "Enter a valid 10-digit Indian mobile number");

export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
] as const;

export const customerSchema = z.object({
  customerName: z.string().trim().min(2, "Please enter your full name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(120),
  phone,
  addressLine1: z.string().trim().min(5, "Please enter your house / street address").max(160),
  addressLine2: z.string().trim().max(160).optional().or(z.literal("")),
  city: z.string().trim().min(2, "Please enter your city").max(60),
  state: z.enum(INDIAN_STATES, { error: "Please select your state" }),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

export const orderSchema = customerSchema.extend({
  paymentMethod: z.enum(["cod", "razorpay"]),
  items: z
    .array(z.object({ variantId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(50) }))
    .min(1, "Your cart is empty")
    .max(60),
});

export type OrderInput = z.infer<typeof orderSchema>;

export const BUSINESS_INTERESTS = {
  distributor: "Distributor / dealer",
  retail: "Retail & supermarket tie-up",
  bulk: "Bulk & wholesale supply",
  horeca: "HoReCa (hotels, restaurants, catering)",
  export: "Export enquiry",
  franchise: "Franchise opportunity",
} as const;

export const enquirySchema = z
  .object({
    type: z.enum(["contact", "business"]),
    name: z.string().trim().min(2, "Please enter your name").max(80),
    email: z.string().trim().toLowerCase().email("Enter a valid email address").max(120),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
    company: z.string().trim().max(120).optional().or(z.literal("")),
    city: z.string().trim().max(80).optional().or(z.literal("")),
    interest: z.enum(Object.keys(BUSINESS_INTERESTS) as [keyof typeof BUSINESS_INTERESTS]).optional(),
    message: z.string().trim().min(10, "Please write a few words (at least 10 characters)").max(2000),
    /** honeypot */
    website: z.string().max(0).optional().or(z.literal("")),
  })
  .superRefine((v, ctx) => {
    if (v.type === "business" && !v.interest) ctx.addIssue({ code: "custom", path: ["interest"], message: "Please choose an enquiry type" });
    if (v.type === "business" && !v.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Please add a phone number so our team can reach you" });
    if (v.phone && !/^\+?[\d\s-]{8,16}$/.test(v.phone)) ctx.addIssue({ code: "custom", path: ["phone"], message: "Enter a valid phone number" });
  });

export const newsletterSchema = z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email address").max(120) });

export function fieldErrors(err: z.ZodError) {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join(".") || "_form";
    if (!out[k]) out[k] = i.message;
  }
  return out;
}
