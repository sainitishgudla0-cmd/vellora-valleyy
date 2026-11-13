import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { releaseHoldsForOrders } from "@/lib/inventory/order-stock";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { TEST_ENQUIRY_WHERE, TEST_ORDER_WHERE, TEST_SUBSCRIBER_WHERE } from "@/lib/test-data";

/** Deletes only records created by the automated tests (admin session required). */
export async function DELETE(req: Request) {
  const auth = await requireAdmin(req, "testdata:write");
  if ("response" in auth) return auth.response;
  const [orders, enquiries, subscribers] = await db.$transaction(async (tx) => {
    // units held by test orders go back to stock before the orders disappear (M3)
    // an order with a tax invoice is never removed (invoice numbers must stay gap-free)
    const ids = (await tx.order.findMany({ where: { ...TEST_ORDER_WHERE, invoice: null }, select: { id: true } })).map((o) => o.id);
    await releaseHoldsForOrders(tx, ids, { type: "admin", id: auth.admin.actorId });
    return Promise.all([tx.order.deleteMany({ where: { id: { in: ids } } }), tx.enquiry.deleteMany({ where: TEST_ENQUIRY_WHERE }), tx.subscriber.deleteMany({ where: TEST_SUBSCRIBER_WHERE })]);
  });
  await writeAudit({ action: "testdata.delete", outcome: "success", admin: auth.admin, details: { orders: orders.count, enquiries: enquiries.count, subscribers: subscribers.count } });
  return json({ ok: true, orders: orders.count, enquiries: enquiries.count, subscribers: subscribers.count });
}
