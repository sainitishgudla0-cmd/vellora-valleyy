import { z } from "zod";
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { isAdmin } from "@/lib/admin-auth";

const schema = z.object({
  // Derived from the Prisma enums so the API and the database cannot drift apart.
  status: z.enum(OrderStatus).optional(),
  paymentStatus: z.enum(PaymentStatus).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;
  const order = await db.order.update({ where: { id: id }, data: parsed.data }).catch(() => null);
  return order ? json({ ok: true }) : fail("Order not found", 404);
}
