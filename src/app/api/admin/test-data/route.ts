import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { releaseHoldsForOrders } from "@/lib/inventory/order-stock";
import { isAdmin } from "@/lib/admin-auth";
import { TEST_ENQUIRY_WHERE, TEST_ORDER_WHERE, TEST_SUBSCRIBER_WHERE } from "@/lib/test-data";

/** Deletes only records created by the automated tests (admin session required). */
export async function DELETE() {
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const [orders, enquiries, subscribers] = await db.$transaction(async (tx) => {
    // units held by test orders go back to stock before the orders disappear (M3)
    const ids = (await tx.order.findMany({ where: TEST_ORDER_WHERE, select: { id: true } })).map((o) => o.id);
    await releaseHoldsForOrders(tx, ids, { type: "admin", id: "test-data-cleanup" });
    return Promise.all([tx.order.deleteMany({ where: { id: { in: ids } } }), tx.enquiry.deleteMany({ where: TEST_ENQUIRY_WHERE }), tx.subscriber.deleteMany({ where: TEST_SUBSCRIBER_WHERE })]);
  });
  return json({ ok: true, orders: orders.count, enquiries: enquiries.count, subscribers: subscribers.count });
}
