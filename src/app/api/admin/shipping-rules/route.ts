import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { shippingRuleSchema } from "@/lib/fulfilment/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const rules = await db.shippingRule.findMany({ orderBy: { pincodePrefix: "asc" } });
  return json({ rules, legacyMode: rules.filter((r) => r.active).length === 0 });
}

/** With no active rule every pincode is served at the site's default fee; with any active rule an order's pincode needs a matching one (longest prefix wins; empty prefix = catch-all). Amounts are paise. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req, "fulfilment:write");
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, shippingRuleSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const r = await db.shippingRule.create({ data: { ...parsed.data, freeAboveSubtotal: parsed.data.freeAboveSubtotal ?? null } });
    await writeAudit({ action: "shipping_rule.create", outcome: "success", admin: auth.admin, targetType: "shipping_rule", targetId: r.id, details: { pincodePrefix: r.pincodePrefix, serviceable: r.serviceable, fee: r.fee } });
    return json({ rule: r }, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await writeAudit({ action: "shipping_rule.create", outcome: "rejected", admin: auth.admin, details: { code: "prefix_in_use" } });
      return Response.json({ error: "A rule for this pincode prefix already exists", code: "prefix_in_use" }, { status: 409 });
    }
    throw e;
  }
}
