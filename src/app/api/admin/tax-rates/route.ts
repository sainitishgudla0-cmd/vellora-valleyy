import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { taxRateSchema } from "@/lib/fulfilment/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "fulfilment:read");
  if ("response" in auth) return auth.response;
  const rates = await db.taxRate.findMany({ orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }], take: 500 });
  return json({ rates: rates.map((r) => ({ id: r.id, code: r.code, rateBp: r.rateBp, effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10), note: r.note })) });
}

/**
 * Add a GST rate (basis points) for an HSN code or `DELIVERY`, effective from a date. Append-only: a change of rate is a new row
 * with a later date; invoices already issued are frozen and never change. Rates are set with the accountant's sign-off (owner only).
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req, "tax:write");
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, taxRateSchema);
  if ("response" in parsed) return parsed.response;
  const { code, rateBp, effectiveFrom, note } = parsed.data;
  try {
    const r = await db.taxRate.create({ data: { code, rateBp, effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`), note: note ?? null } });
    await writeAudit({ action: "tax_rate.create", outcome: "success", admin: auth.admin, targetType: "tax_rate", targetId: r.id, details: { code, rateBp, effectiveFrom } });
    return json({ rate: { id: r.id, code, rateBp, effectiveFrom, note: r.note } }, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await writeAudit({ action: "tax_rate.create", outcome: "rejected", admin: auth.admin, details: { code, effectiveFrom, reason: "exists" } });
      return Response.json({ error: "A rate for this code and date already exists. Add a new row with a later date to change it.", code: "rate_exists" }, { status: 409 });
    }
    throw e;
  }
}
