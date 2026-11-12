/** M2-T1: enum-typed columns behave correctly through Prisma Client on a migrated disposable database. */
import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const PREFIX = "VV-ENUM-";
let seq = 0;
const base = () => {
  const n = `${PREFIX}${Date.now()}-${seq++}`;
  return {
    number: n,
    accessToken: `tok-${n}`,
    customerName: "SMOKE TEST Enum",
    email: "smoke.enum@example.com",
    phone: "9876543210",
    addressLine1: "1 Test Street",
    city: "Anantapur",
    state: "Andhra Pradesh",
    pincode: "515001",
    subtotal: 1000,
    deliveryFee: 50,
    total: 1050,
  };
};

afterAll(async () => {
  await db.order.deleteMany({ where: { number: { startsWith: PREFIX } } });
  await db.$disconnect();
});

describe("Order enum columns", () => {
  it("defaults paymentStatus to unpaid and round-trips pay-on-delivery as an unpaid request", async () => {
    const o = await db.order.create({ data: { ...base(), status: "pending_confirmation", paymentMethod: "cod" } });
    expect(o.paymentStatus).toBe("unpaid");
    expect(JSON.parse(JSON.stringify(o))).toMatchObject({ status: "pending_confirmation", paymentMethod: "cod", paymentStatus: "unpaid" });
  });

  it("supports filtering with the same queries the admin dashboard and verify route use", async () => {
    const a = await db.order.create({ data: { ...base(), status: "pending_confirmation", paymentMethod: "cod" } });
    const b = await db.order.create({ data: { ...base(), status: "paid", paymentMethod: "razorpay", paymentStatus: "paid" } });
    const n = await db.order.count({ where: { id: { in: [a.id, b.id] }, status: { in: ["pending_confirmation", "paid"] } } });
    expect(n).toBe(2);
    const claimed = await db.order.updateMany({ where: { id: a.id, status: "awaiting_payment", paymentStatus: { in: ["unpaid", "failed"] } }, data: { status: "paid" } });
    expect(claimed.count).toBe(0); // conditional update on a different state matches nothing
    expect((await db.order.findUnique({ where: { id: b.id }, select: { status: true, paymentStatus: true } }))).toEqual({ status: "paid", paymentStatus: "paid" });
  });

  it.each([
    ["status", { status: "shipped" }],
    ["paymentStatus", { paymentStatus: "settled" }],
    ["paymentMethod", { paymentMethod: "upi" }],
  ])("rejects an unsupported %s even if the type system is bypassed", async (_c, over) => {
    const data = { ...base(), status: "pending_confirmation", paymentMethod: "cod", ...over } as unknown as Prisma.OrderCreateInput;
    await expect(db.order.create({ data })).rejects.toThrow();
    expect(await db.order.count({ where: { number: data.number } })).toBe(0);
  });
});
