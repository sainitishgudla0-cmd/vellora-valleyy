import "server-only";
import { Prisma, type ShipmentStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Shipments and tracking (M7-T4, ADR 0015). A shipment records the courier, AWB and tracking history for an order. It does NOT move
 * the order's status: dispatching and delivering stay explicit, audited admin changes through the order state machine (create the
 * shipment first, then mark the order dispatched, so the dispatch email carries the tracking details). Courier API integration
 * (live tracking, label printing) waits for the courier decision.
 */
export const SHIPPABLE_ORDER_STATUSES = ["confirmed", "paid", "dispatched"] as const;

export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  created: ["picked_up", "in_transit", "failed"],
  picked_up: ["in_transit", "failed", "returned"],
  in_transit: ["out_for_delivery", "delivered", "failed", "returned"],
  out_for_delivery: ["delivered", "failed", "in_transit"],
  failed: ["in_transit", "returned"],
  delivered: [],
  returned: [],
};

export type ShipmentCode = "not_found" | "order_not_shippable" | "awb_in_use" | "invalid_transition" | "stale_state";
export type ShipmentResult<T = object> = ({ ok: true } & T) | { ok: false; code: ShipmentCode; message: string };
const fail = (code: ShipmentCode, message: string): { ok: false; code: ShipmentCode; message: string } => ({ ok: false, code, message });

export async function createShipment(orderId: string, input: { courier: string; awb: string; trackingUrl?: string }): Promise<ShipmentResult<{ shipmentId: string }>> {
  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (!order) return fail("not_found", "Order not found");
      if (!(SHIPPABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) return fail("order_not_shippable", `An order that is ${order.status} cannot be shipped`);
      const s = await tx.shipment.create({ data: { orderId, courier: input.courier, awb: input.awb, trackingUrl: input.trackingUrl ?? null, events: { create: { status: "created" } } } });
      return { ok: true as const, shipmentId: s.id };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return fail("awb_in_use", "This courier already has a shipment with that tracking number");
    throw e;
  }
}

export async function updateShipmentStatus(shipmentId: string, to: ShipmentStatus, note?: string): Promise<ShipmentResult> {
  return db.$transaction(async (tx) => {
    const s = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { status: true } });
    if (!s) return fail("not_found", "Shipment not found");
    if (!SHIPMENT_TRANSITIONS[s.status].includes(to)) return fail("invalid_transition", `A shipment cannot move from ${s.status} to ${to}`);
    const r = await tx.shipment.updateMany({ where: { id: shipmentId, status: s.status }, data: { status: to } });
    if (r.count !== 1) return fail("stale_state", "The shipment changed while you were editing it");
    await tx.shipmentEvent.create({ data: { shipmentId, status: to, note: note?.trim() || null } });
    return { ok: true as const };
  });
}
