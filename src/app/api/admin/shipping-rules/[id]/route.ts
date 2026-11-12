import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { shippingRulePatchSchema } from "@/lib/fulfilment/schemas";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, shippingRulePatchSchema);
  if ("response" in parsed) return parsed.response;
  const audit = (outcome: "success" | "rejected", code?: string) => writeAudit({ action: "shipping_rule.update", outcome, admin: auth.admin, targetType: "shipping_rule", targetId: id, details: { fields: Object.keys(parsed.data), ...(code ? { code } : {}) } });
  try {
    const r = await db.shippingRule.update({ where: { id }, data: parsed.data });
    await audit("success");
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
  const r = await db.shippingRule.deleteMany({ where: { id } });
  await writeAudit({ action: "shipping_rule.delete", outcome: r.count ? "success" : "rejected", admin: auth.admin, targetType: "shipping_rule", targetId: id });
  return r.count ? json({ ok: true }) : fail("Shipping rule not found", 404);
}
