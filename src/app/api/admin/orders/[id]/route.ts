import { NextResponse } from "next/server";
import { z } from "zod";
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { updateOrderAsAdmin } from "@/lib/orders/admin-update";

const schema = z.object({
  // Derived from the Prisma enums so the API and the database cannot drift apart.
  status: z.enum(OrderStatus).optional(),
  paymentStatus: z.enum(PaymentStatus).optional(),
  // Free text recorded on the audit event. Required for payment edits (enforced by the state machine).
  reason: z.string().trim().max(500).optional(),
  // External payment reference for a manual payment confirmation (request-only orders).
  paymentReference: z.string().trim().max(80).optional(),
});

/** Contract: docs/API-CONTRACTS.md (Admin). Every change goes through the order state machine (ADR 0010). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "orders:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;

  const r = await updateOrderAsAdmin({ orderId: id, ...parsed.data, adminId: auth.admin.actorId });
  // ids and field names only: the free-text reason and payment reference live on the OrderEvent, not here
  const base = { action: "order.update", admin: auth.admin, targetType: "order", targetId: id } as const;
  const changed = { status: parsed.data.status, paymentStatus: parsed.data.paymentStatus };
  if (r.ok) {
    await writeAudit({ ...base, outcome: "success", details: { ...changed, changed: r.changed } });
    return json({ ok: true });
  }
  await writeAudit({ ...base, outcome: "rejected", details: { ...changed, code: r.code } });
  switch (r.code) {
    case "not_found":
      return fail("Order not found", 404);
    case "reason_required":
      return fail(r.message, 422, { reason: "A reason is required for this change" });
    case "reference_required":
    case "invalid_reason":
      return fail(r.message, 422, { [r.code === "reference_required" ? "paymentReference" : "reason"]: r.message });
    default:
      // invalid_transition, actor_not_allowed, stale_state, payment_edit_not_allowed, no_payment_record, reference_in_use
      return NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
  }
}
