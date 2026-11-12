import { NextResponse } from "next/server";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { shipmentPatchSchema } from "@/lib/fulfilment/schemas";
import { updateShipmentStatus } from "@/lib/shipping/shipments";

/** Move a shipment along its tracking graph (created -> picked_up -> in_transit -> out_for_delivery -> delivered, or failed/returned). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, shipmentPatchSchema);
  if ("response" in parsed) return parsed.response;
  const r = await updateShipmentStatus(id, parsed.data.status, parsed.data.note);
  await writeAudit({ action: "shipment.update", outcome: r.ok ? "success" : "rejected", admin: auth.admin, targetType: "shipment", targetId: id, details: { status: parsed.data.status, ...(r.ok ? {} : { code: r.code }) } });
  if (r.ok) return json({ ok: true });
  return r.code === "not_found" ? fail(r.message, 404) : NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
}
