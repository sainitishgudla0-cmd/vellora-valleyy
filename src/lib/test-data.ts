import "server-only";
import type { Prisma } from "@prisma/client";

/** Records created by the automated smoke / UI tests (scripts/smoke-test.ts, tests/e2e). */
export const TEST_ORDER_WHERE: Prisma.OrderWhereInput = {
  OR: [{ customerName: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }],
};
export const TEST_ENQUIRY_WHERE: Prisma.EnquiryWhereInput = {
  OR: [{ name: { startsWith: "SMOKE TEST" } }, { email: { startsWith: "smoke." } }],
};
export const TEST_SUBSCRIBER_WHERE: Prisma.SubscriberWhereInput = { email: { startsWith: "smoke." } };
