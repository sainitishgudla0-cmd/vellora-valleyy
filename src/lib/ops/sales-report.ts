import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { TEST_ORDER_WHERE } from "@/lib/test-data";

/**
 * Sales summary for the admin Operations tab (M12, admin reporting). Read-only, integer paise, Indian calendar days.
 * Automated-test orders (`SMOKE TEST` / `smoke.`) are left out. "Order value" counts every order not cancelled;
 * "collected" only orders whose payment is recorded as paid (online capture or a recorded pay-on-delivery collection).
 * Refunds are listed separately: an order refunded in full has payment status `refunded` and is not counted as collected.
 */
export interface SalesPeriod {
  key: "today" | "last7" | "month";
  label: string;
  from: Date;
  orders: number;
  wholesaleOrders: number;
  value: number;
  collected: number;
  cancelled: number;
}
export interface TopProduct {
  productName: string;
  units: number;
  value: number;
}

const IST_OFFSET_MS = 5.5 * 3600_000;
/** Midnight in India (as a UTC instant) of the Indian calendar day `daysAgo` days before `now`. */
export function istDayStart(now: Date, daysAgo = 0): Date {
  const d = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(new Date(`${d}T00:00:00.000Z`).getTime() - IST_OFFSET_MS - daysAgo * 86_400_000);
}
export function istMonthStart(now: Date): Date {
  const m = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
  return new Date(new Date(`${m}-01T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

const real: Prisma.OrderWhereInput = { NOT: TEST_ORDER_WHERE };

async function period(key: SalesPeriod["key"], label: string, from: Date): Promise<SalesPeriod> {
  const since = { createdAt: { gte: from } };
  const [open, wholesale, paid, cancelled] = await Promise.all([
    db.order.aggregate({ where: { AND: [real, since, { status: { not: "cancelled" } }] }, _count: { _all: true }, _sum: { total: true } }),
    db.order.count({ where: { AND: [real, since, { status: { not: "cancelled" } }, { businessAccountId: { not: null } }] } }),
    db.order.aggregate({ where: { AND: [real, since, { paymentStatus: "paid" }] }, _sum: { total: true } }),
    db.order.count({ where: { AND: [real, since, { status: "cancelled" }] } }),
  ]);
  return { key, label, from, orders: open._count._all, wholesaleOrders: wholesale, value: open._sum.total ?? 0, collected: paid._sum.total ?? 0, cancelled };
}

export async function salesSummary(now = new Date()): Promise<{ periods: SalesPeriod[]; topProducts: TopProduct[] }> {
  const month = istMonthStart(now);
  const [periods, top] = await Promise.all([
    Promise.all([period("today", "Today", istDayStart(now)), period("last7", "Last 7 days", istDayStart(now, 6)), period("month", "This month", month)]),
    db.orderItem.groupBy({
      by: ["productName"],
      where: { order: { AND: [real, { createdAt: { gte: month } }, { status: { not: "cancelled" } }] } },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: "desc" } },
      take: 5,
    }),
  ]);
  return { periods, topProducts: top.map((t) => ({ productName: t.productName, units: t._sum.quantity ?? 0, value: t._sum.lineTotal ?? 0 })) };
}
