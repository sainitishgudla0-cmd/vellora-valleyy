import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { shipmentCreateSchema } from "@/lib/fulfilment/schemas";
import { createShipment } from "@/lib/shipping/shipments";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const shipments = await db.shipment.findMany({ where: { orderId: id }, orderBy: { createdAt: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } } });
  return json({ shipments });
}

/** Record a shipment (courier + AWB) for a confirmed/paid/dispatched order. It does not change the order's status. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, shipmentCreateSchema);
  if ("response" in parsed) return parsed.response;
  const r = await createShipment(id, parsed.data);
  await writeAudit({ action: "shipment.create", outcome: r.ok ? "success" : "rejected", admin: auth.admin, targetType: "order", targetId: id, details: r.ok ? { courier: parsed.data.courier } : { code: r.code } });
  if (r.ok) return json({ shipmentId: r.shipmentId }, 201);
  return r.code === "not_found" ? fail(r.message, 404) : NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
}
