import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit, writeAuditTx } from "@/lib/auth/audit";
import { shippingRulePatchSchema } from "@/lib/fulfilment/schemas";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, shippingRulePatchSchema);
  if ("response" in parsed) return parsed.response;
  const audit = (outcome: "rejected", code: string) => writeAudit({ action: "shipping_rule.update", outcome, admin: auth.admin, targetType: "shipping_rule", targetId: id, details: { fields: Object.keys(parsed.data), code } });
  try {
    const r = await db.$transaction(async (tx) => {
      const rule = await tx.shippingRule.update({ where: { id }, data: parsed.data });
      await writeAuditTx(tx, { action: "shipping_rule.update", outcome: "success", admin: auth.admin, targetType: "shipping_rule", targetId: id, details: { fields: Object.keys(parsed.data), fee: rule.fee, serviceable: rule.serviceable, freeAboveSubtotal: rule.freeAboveSubtotal, active: rule.active } });
      return rule;
    });
    return json({ rule: r });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2025" || e.code === "P2002")) {
      await audit("rejected", e.code === "P2025" ? "not_found" : "prefix_in_use");
      return e.code === "P2025" ? fail("Shipping rule not found", 404) : Response.json({ error: "A rule for this pincode prefix already exists", code: "prefix_in_use" }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const deleted = await db.$transaction(async (tx) => {
    const r = await tx.shippingRule.deleteMany({ where: { id } });
    if (r.count) await writeAuditTx(tx, { action: "shipping_rule.delete", outcome: "success", admin: auth.admin, targetType: "shipping_rule", targetId: id });
    return r.count > 0;
  });
  if (!deleted) await writeAudit({ action: "shipping_rule.delete", outcome: "rejected", admin: auth.admin, targetType: "shipping_rule", targetId: id, details: { code: "not_found" } });
  return deleted ? json({ ok: true }) : fail("Shipping rule not found", 404);
}
