import { fail, json } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/customer";
import { getOrder } from "@/lib/account/orders";

export const dynamic = "force-dynamic";

/** One of your orders. Someone else's order number answers exactly like an unknown one (404). */
export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await requireCustomer(req);
  if ("response" in auth) return auth.response;
  const { number } = await params;
  const order = await getOrder(auth.customer.customerId, number);
  return order ? json({ order }) : fail("Order not found", 404);
}
