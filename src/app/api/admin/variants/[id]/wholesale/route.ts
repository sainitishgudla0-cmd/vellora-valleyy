import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { wholesaleTermsSchema } from "@/lib/wholesale/schemas";

/** Wholesale MOQ and case pack for a variant (1 / 1 = no restriction). Never affects retail checkout. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "pricing:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, wholesaleTermsSchema);
  if ("response" in parsed) return parsed.response;
  if (!(await db.variant.findUnique({ where: { id }, select: { id: true } }))) {
    await writeAudit({ action: "variant.wholesale", outcome: "rejected", admin: auth.admin, targetType: "variant", targetId: id, details: { code: "not_found" } });
    return fail("Variant not found", 404);
  }
  const t = await db.variantWholesale.upsert({ where: { variantId: id }, create: { variantId: id, ...parsed.data }, update: parsed.data });
  await writeAudit({ action: "variant.wholesale", outcome: "success", admin: auth.admin, targetType: "variant", targetId: id, details: parsed.data });
  return json({ ok: true, moq: t.moq, casePack: t.casePack });
}
