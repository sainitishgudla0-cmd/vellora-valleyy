import { fail, json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { deleteAddress, updateAddress } from "@/lib/account/addresses";
import { addressPatchSchema } from "@/lib/account/schemas";

/** Another customer's address id answers exactly like a missing one (404). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, addressPatchSchema);
  if ("response" in parsed) return parsed.response;
  const r = await updateAddress(auth.customer.customerId, id, parsed.data);
  return r.ok ? json({ address: r.address }) : fail(r.message, 404);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const r = await deleteAddress(auth.customer.customerId, id);
  return r.ok ? json({ ok: true }) : fail(r.message, 404);
}
