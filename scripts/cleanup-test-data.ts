/** Removes orders, enquiries and subscribers created by the smoke / UI tests. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const orders = await db.order.deleteMany({ where: { OR: [{ customerName: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] } });
  const enquiries = await db.enquiry.deleteMany({ where: { OR: [{ name: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] } });
  const subs = await db.subscriber.deleteMany({ where: { email: { startsWith: "smoke." } } });
  console.log(`Removed ${orders.count} test orders, ${enquiries.count} test enquiries, ${subs.count} test subscribers`);
}

main().finally(() => db.$disconnect());
