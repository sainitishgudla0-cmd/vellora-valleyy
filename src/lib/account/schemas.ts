import { z } from "zod";
import { INDIAN_STATES, phone } from "@/lib/validation";

/** Request schemas for /api/account/*. Strict objects: unknown fields (e.g. `customerId`) are rejected, never ignored. */
const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(120);

export const otpRequestSchema = z.strictObject({ email });
export const otpVerifySchema = z.strictObject({
  email,
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
  /** required the first time an address signs in (creates the account) */
  acceptTerms: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

export const profilePatchSchema = z.strictObject({
  name: z.string().trim().min(2, "Please enter your full name").max(80).nullable().optional(),
  phone: phone.nullable().optional(),
});

const addressFields = {
  label: z.string().trim().max(40).nullable().optional(),
  name: z.string().trim().min(2, "Please enter the recipient's name").max(80),
  phone,
  line1: z.string().trim().min(5, "Please enter the house / street address").max(160),
  line2: z.string().trim().max(160).nullable().optional(),
  city: z.string().trim().min(2, "Please enter the city").max(60),
  state: z.enum(INDIAN_STATES, { error: "Please select the state" }),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode"),
  isDefault: z.boolean().optional(),
};
export const addressCreateSchema = z.strictObject(addressFields);
export const addressPatchSchema = z.strictObject(addressFields).partial().refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const consentSchema = z.strictObject({ marketing: z.boolean() });

export const claimSchema = z.union([
  z.strictObject({ mode: z.literal("email") }),
  z.strictObject({ orderNumber: z.string().trim().min(1).max(40), token: z.string().trim().min(1).max(100) }),
]);

export const deleteAccountSchema = z.strictObject({ confirm: z.literal("DELETE") });
