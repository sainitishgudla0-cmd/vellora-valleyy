/**
 * Removes orders, enquiries and subscribers created by the smoke / UI tests.
 * Deletes rows, so it only runs against a disposable database (TEST_TARGET=disposable + loopback or
 * DISPOSABLE_DB_HOSTS). Run with `tsx --conditions=react-server` (package script) because it shares server-only code. Production test data is removed from /admin ("Remove test data") instead.
 */
import { PrismaClient } from "@prisma/client";
import { releaseHoldsForOrders } from "../src/lib/inventory/order-stock";
import { assertDisposableDatabase, assertTestTargetDeclared } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
let target: ReturnType<typeof assertDisposableDatabase>;
try {
  assertTestTargetDeclared();
  target = assertDisposableDatabase(process.env, "test-data cleanup");
} catch (e) {
  console.error(`[cleanup] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.log(`Cleaning test data in ${target.host}/${target.database}`);
const db = new PrismaClient();

async function main() {
  const orders = await db.$transaction(async (tx) => {
    const where = { OR: [{ customerName: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] };
    const ids = (await tx.order.findMany({ where: { ...where, invoice: null }, select: { id: true } })).map((o) => o.id); // invoiced orders stay (gap-free numbering)
    await releaseHoldsForOrders(tx, ids, { type: "system", id: "test-data-cleanup" }); // units held by test orders go back to stock first (M3)
    return tx.order.deleteMany({ where: { id: { in: ids } } });
  });
  const enquiries = await db.enquiry.deleteMany({ where: { OR: [{ name: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] } });
  const subs = await db.subscriber.deleteMany({ where: { email: { startsWith: "smoke." } } });
  // browser-test shoppers and wholesale buyers (smoke.* addresses): their orders and quotes first, then accounts, price lists and the customers
  const bizIds = (await db.businessAccount.findMany({ where: { contactEmail: { startsWith: "smoke." } }, select: { id: true } })).map((b) => b.id);
  await db.order.deleteMany({ where: { businessAccountId: { in: bizIds }, invoice: null } });
  await db.quote.deleteMany({ where: { businessAccountId: { in: bizIds } } });
  await db.businessAccount.deleteMany({ where: { id: { in: bizIds } } });
  await db.priceList.deleteMany({ where: { name: { startsWith: "e2e-" } } });
  const customers = await db.customer.deleteMany({ where: { email: { startsWith: "smoke." } } });
  const admins = await db.adminUser.deleteMany({ where: { email: { startsWith: "smoke." } } }); // browser-test accounts (sessions cascade)
  const limits = await db.rateLimitBucket.deleteMany({}); // counters live in the (disposable) database now: a re-run must not inherit a spent window
  console.log(`Removed ${limits.count} rate-limit counters, ${orders.count} test orders, ${enquiries.count} test enquiries, ${subs.count} test subscribers, ${admins.count} test admin accounts, ${customers.count} test shoppers`);
}

main().finally(() => db.$disconnect());
