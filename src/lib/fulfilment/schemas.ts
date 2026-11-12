import { z } from "zod";

/** Request schemas for the M7 admin and public endpoints. Strict: unknown fields are rejected. Money is integer paise. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");

export const taxRateSchema = z.strictObject({
  /** an HSN code (4, 6 or 8 digits) or DELIVERY */
  code: z.string().trim().toUpperCase().regex(/^(DELIVERY|\d{4}|\d{6}|\d{8})$/, "Use a 4, 6 or 8 digit HSN code, or DELIVERY"),
  /** basis points: 1800 = 18% */
  rateBp: z.number().int().min(0).max(5000),
  effectiveFrom: date,
  note: z.string().trim().max(200).optional(),
});

const ruleFields = {
  name: z.string().trim().min(2).max(80),
  /** 1-6 digits, or empty for the catch-all */
  pincodePrefix: z.string().trim().regex(/^\d{0,6}$/, "1 to 6 digits, or empty for all pincodes"),
  serviceable: z.boolean(),
  fee: z.number().int().min(0).max(100_000_000),
  freeAboveSubtotal: z.number().int().min(1).max(1_000_000_000).nullable(),
  active: z.boolean(),
};
/** Creating applies defaults; PATCH must NOT (a default would silently overwrite a stored value), so it is built from the plain fields. */
export const shippingRuleSchema = z.strictObject({ ...ruleFields, serviceable: ruleFields.serviceable.default(true), fee: ruleFields.fee.default(0), freeAboveSubtotal: ruleFields.freeAboveSubtotal.optional(), active: ruleFields.active.default(true) });
export const shippingRulePatchSchema = z.strictObject(ruleFields).partial().refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const shippingQuoteQuery = z.object({ pincode: z.string().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode"), subtotal: z.coerce.number().int().min(0).max(1_000_000_000).default(0) });

const SHIPMENT_STATUSES = ["created", "picked_up", "in_transit", "out_for_delivery", "delivered", "failed", "returned"] as const;
export const shipmentCreateSchema = z.strictObject({
  courier: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 .&-]{1,39}$/, "Courier name, 2-40 characters"),
  awb: z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, "Tracking (AWB) number, 4-40 letters, digits or dashes"),
  trackingUrl: z.string().trim().max(300).url().refine((u) => u.startsWith("https://"), "Tracking link must be https").optional(),
});
export const shipmentPatchSchema = z.strictObject({ status: z.enum(SHIPMENT_STATUSES), note: z.string().trim().max(300).optional() });

export const outboxQuery = z.object({ status: z.enum(["pending", "sending", "sent", "failed", "dead"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
