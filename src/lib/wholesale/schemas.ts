import { z } from "zod";
import { BUSINESS_INTERESTS, customerSchema } from "@/lib/validation";
import { validateGstin } from "./gstin";

/** Request schemas for /api/business/* and the wholesale admin API. All money is integer paise. Strict where a client could smuggle fields. */
const MAX_QTY = 100_000;
const lineItem = z.strictObject({ variantId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(MAX_QTY) });
const items = z.array(lineItem).min(1, "Add at least one item").max(60);
const interest = z.enum(Object.keys(BUSINESS_INTERESTS) as [keyof typeof BUSINESS_INTERESTS]);

const gstin = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((s, ctx) => {
    const g = validateGstin(s);
    if (!g.ok) {
      ctx.addIssue({ code: "custom", message: g.error });
      return z.NEVER;
    }
    return g.gstin;
  });

export const applySchema = z.strictObject({
  companyName: z.string().trim().min(2, "Please enter the company name").max(120),
  gstin,
  contactName: z.string().trim().min(2, "Please enter a contact name").max(80),
  phone: customerSchema.shape.phone,
  interest: interest.optional(),
  message: z.string().trim().max(1000).optional(),
});

export const businessCartSchema = z.strictObject({ items });
export const businessOrderSchema = customerSchema.extend({ items }).strict();
export const quoteRequestSchema = z.strictObject({ items, note: z.string().trim().max(1000).optional() });
export const quoteAcceptSchema = customerSchema.strict();

// ---- admin
const paise = z.number().int().min(0).max(1_000_000_000);
export const accountPatchSchema = z
  .strictObject({
    status: z.enum(["pending", "approved", "rejected", "suspended", "closed"]).optional(),
    priceListId: z.string().min(1).max(40).nullable().optional(),
    paymentTerms: z.enum(["prepaid", "credit"]).optional(),
    /** paise */
    creditLimit: paise.optional(),
    /** internal, never shown to the buyer */
    adminNote: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const convertSchema = z.strictObject({
  companyName: z.string().trim().min(2).max(120),
  gstin,
  approve: z.boolean().optional(),
  priceListId: z.string().min(1).max(40).nullable().optional(),
  paymentTerms: z.enum(["prepaid", "credit"]).optional(),
  creditLimit: paise.optional(),
});

export const priceListCreateSchema = z.strictObject({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional() });
export const priceListPatchSchema = z.strictObject({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(300).nullable().optional(), active: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, "Nothing to change");
/** Replaces ALL tiers of one variant in the list. An empty `tiers` removes the variant from the list. */
export const priceTiersSchema = z.strictObject({
  variantId: z.string().min(1).max(40),
  tiers: z.array(z.strictObject({ minQty: z.number().int().min(1).max(MAX_QTY), unitPrice: z.number().int().min(1).max(100_000_000) })).max(10),
});
export const wholesaleTermsSchema = z.strictObject({ moq: z.number().int().min(1).max(MAX_QTY), casePack: z.number().int().min(1).max(MAX_QTY) });

export const quoteActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("quote"),
    items: z.array(z.strictObject({ variantId: z.string().min(1).max(40), unitPrice: z.number().int().min(1).max(100_000_000) })).min(1).max(60),
    deliveryFee: paise.optional(),
    validDays: z.number().int().min(1).max(30).optional(),
    buyerNote: z.string().trim().max(1000).nullable().optional(),
  }),
  z.strictObject({ action: z.literal("reject") }),
  z.strictObject({ action: z.literal("cancel") }),
]);
