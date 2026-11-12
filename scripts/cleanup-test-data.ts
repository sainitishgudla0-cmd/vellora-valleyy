/**
 * Removes orders, enquiries and subscribers created by the smoke / UI tests.
 * Deletes rows, so it only runs against a disposable database (TEST_TARGET=disposable + loopback or
 * DISPOSABLE_DB_HOSTS). Production test data is removed from /admin ("Remove test data") instead.
 */
import { PrismaClient } from "@prisma/client";
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
  const orders = await db.order.deleteMany({ where: { OR: [{ customerName: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] } });
  const enquiries = await db.enquiry.deleteMany({ where: { OR: [{ name: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }] } });
  const subs = await db.subscriber.deleteMany({ where: { email: { startsWith: "smoke." } } });
  console.log(`Removed ${orders.count} test orders, ${enquiries.count} test enquiries, ${subs.count} test subscribers`);
}

main().finally(() => db.$disconnect());
