import { fail, json, parseBody } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { createAddress, listAddresses } from "@/lib/account/addresses";
import { addressCreateSchema } from "@/lib/account/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  return json({ addresses: await listAddresses(auth.customer.customerId) });
}

export async function POST(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, addressCreateSchema);
  if ("response" in parsed) return parsed.response;
  const r = await createAddress(auth.customer.customerId, parsed.data);
  return r.ok ? json({ address: r.address }, 201) : Response.json({ error: r.message, code: r.code }, { status: 409 });
}
