import { fail, json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { getProfile, updateProfile } from "@/lib/account/profile";
import { profilePatchSchema } from "@/lib/account/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const profile = await getProfile(auth.customer.customerId);
  return profile ? json({ customer: profile }) : fail("Please sign in", 401);
}

/** Update name and phone. Email cannot be changed here (it is the sign-in identity). */
export async function PATCH(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, profilePatchSchema);
  if ("response" in parsed) return parsed.response;
  return json({ customer: await updateProfile(auth.customer.customerId, parsed.data) });
}
