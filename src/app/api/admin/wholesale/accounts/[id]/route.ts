import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { updateAccountAsAdmin } from "@/lib/wholesale/accounts";
import { accountPatchSchema } from "@/lib/wholesale/schemas";
import { accountAdminView } from "@/lib/wholesale/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const a = await db.businessAccount.findUnique({ where: { id } });
  if (!a) return fail("Account not found", 404);
  const [orders, quotes] = await Promise.all([db.order.count({ where: { businessAccountId: id } }), db.quote.count({ where: { businessAccountId: id } })]);
  return json({ account: accountAdminView(a), orders, quotes });
}

/** Approve / reject / suspend / close, set the price list, payment terms and credit limit (paise). Status moves follow the account graph. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, accountPatchSchema);
  if ("response" in parsed) return parsed.response;
  const r = await updateAccountAsAdmin(id, parsed.data, auth.admin.actorId);
  // field names and the status only: the staff note is not copied into the log
  await writeAudit({ action: "business_account.update", outcome: r.ok ? "success" : "rejected", admin: auth.admin, targetType: "business_account", targetId: id, details: { fields: Object.keys(parsed.data), ...(parsed.data.status ? { status: parsed.data.status } : {}), ...(r.ok ? {} : { code: r.code }) } });
  if (r.ok) return json({ ok: true, account: accountAdminView(r.account) });
  if (r.code === "not_found") return fail(r.message, 404);
  if (r.code === "credit_limit_required" || r.code === "price_list_not_found") return fail(r.message, 422);
  return NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
}
