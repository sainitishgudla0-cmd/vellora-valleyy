import { db } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { isAdmin } from "@/lib/admin-auth";
import { TEST_ENQUIRY_WHERE, TEST_ORDER_WHERE, TEST_SUBSCRIBER_WHERE } from "@/lib/test-data";

/** Deletes only records created by the automated tests (admin session required). */
export async function DELETE() {
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const [orders, enquiries, subscribers] = await db.$transaction([
    db.order.deleteMany({ where: TEST_ORDER_WHERE }),
    db.enquiry.deleteMany({ where: TEST_ENQUIRY_WHERE }),
    db.subscriber.deleteMany({ where: TEST_SUBSCRIBER_WHERE }),
  ]);
  return json({ ok: true, orders: orders.count, enquiries: enquiries.count, subscribers: subscribers.count });
}
