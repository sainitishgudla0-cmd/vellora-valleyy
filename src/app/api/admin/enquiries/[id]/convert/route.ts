import { NextResponse } from "next/server";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { convertEnquiry } from "@/lib/wholesale/accounts";
import { convertSchema } from "@/lib/wholesale/schemas";

/** Turn a business enquiry into a business account (pending, or approved at once). The enquirer is linked when they sign in with the enquiry's email. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "wholesale:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, convertSchema);
  if ("response" in parsed) return parsed.response;
  const r = await convertEnquiry(id, parsed.data);
  await writeAudit({ action: "enquiry.convert", outcome: r.ok ? "success" : "rejected", admin: auth.admin, targetType: "enquiry", targetId: id, details: r.ok ? { account: r.account.id, approved: r.account.status === "approved" } : { code: r.code } });
  if (r.ok) return json({ ok: true, accountId: r.account.id, status: r.account.status }, 201);
  if (r.code === "not_found") return fail(r.message, 404);
  if (r.code === "invalid_gstin" || r.code === "credit_limit_required" || r.code === "price_list_not_found") return fail(r.message, 422);
  return NextResponse.json({ error: r.message, code: r.code }, { status: 409 });
}
