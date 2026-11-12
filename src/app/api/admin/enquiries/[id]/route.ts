import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req, "enquiries:write");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await parseBody(req, z.object({ status: z.enum(["new", "in_progress", "closed"]) }));
  if ("response" in parsed) return parsed.response;
  const e = await db.enquiry.update({ where: { id: id }, data: parsed.data }).catch(() => null);
  await writeAudit({ action: "enquiry.update", outcome: e ? "success" : "rejected", admin: auth.admin, targetType: "enquiry", targetId: id, details: { status: parsed.data.status, ...(e ? {} : { code: "not_found" }) } });
  return e ? json({ ok: true }) : fail("Enquiry not found", 404);
}
