import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { safePaymentConfig } from "@/lib/payments";
import { createRefund, listOrderRefunds } from "@/lib/payments/refunds";

const schema = z
  .object({
    // paise; omitted = the whole refundable balance
    amountPaise: z.number().int().positive().max(100_000_000).optional(),
    reason: z.string().trim().min(3).max(500),
    // idempotency key: replaying it returns the same refund
    requestKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    paymentId: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/** Refund ledger and balances for an order. Contract: docs/API-CONTRACTS.md (Admin). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "admin:read");
  if ("response" in auth) return auth.response;
  const r = await listOrderRefunds((await params).id);
  return r ? json(r) : fail("Order not found", 404);
}

/** Start a full or partial refund of an order's captured online payment (M10-T4). Owner-only (`refunds:write`). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "refunds:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;

  const r = await createRefund({ orderId: id, ...parsed.data, adminId: auth.admin.actorId }, safePaymentConfig());
  // ids and codes only: the reason lives on the Refund row
  const base = { action: "order.refund", admin: auth.admin, targetType: "order", targetId: id } as const;
  if (r.ok) {
    await writeAudit({ ...base, outcome: "success", details: { refundId: r.refund.id, status: r.refund.status, replayed: r.replayed } });
    return json({ ok: true, replayed: r.replayed, refund: r.refund }, r.replayed ? 200 : 201);
  }
  await writeAudit({ ...base, outcome: r.code === "gateway_unknown" ? "failed" : "rejected", details: { code: r.code, refundId: r.refund?.id } });
  switch (r.code) {
    case "not_found":
      return fail("Order not found", 404);
    case "unavailable":
      return fail(r.message, 503);
    case "gateway_rejected":
    case "gateway_unknown":
      return NextResponse.json({ error: r.message, code: r.code, refund: r.refund }, { status: 502 });
    default:
      // not_refundable, exceeds_refundable, fully_refunded, key_reused
      return NextResponse.json({ error: r.message, code: r.code, remainingPaise: r.remaining }, { status: 409 });
  }
}
