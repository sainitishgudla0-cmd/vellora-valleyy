import { z } from "zod";
import { fail, json } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { listOrders, MAX_PAGE } from "@/lib/account/orders";

export const dynamic = "force-dynamic";

const query = z.object({ limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(20), cursor: z.string().max(80).optional() });

/** The signed-in customer's own orders, newest first. Page with `cursor=<nextCursor>`. */
export async function GET(req: Request) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ limit: sp.get("limit") ?? undefined, cursor: sp.get("cursor") ?? undefined });
  if (!q.success) return fail("Invalid query", 422);
  try {
    return json(await listOrders(auth.customer.customerId, q.data));
  } catch (e) {
    if (e instanceof RangeError) return fail("Invalid cursor", 422);
    throw e;
  }
}
