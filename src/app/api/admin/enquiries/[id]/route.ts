import { z } from "zod";
import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { isAdmin } from "@/lib/admin-auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return fail("Unauthorized", 401);
  const { id } = await params;
  const parsed = await parseBody(req, z.object({ status: z.enum(["new", "in_progress", "closed"]) }));
  if ("response" in parsed) return parsed.response;
  const e = await db.enquiry.update({ where: { id: id }, data: parsed.data }).catch(() => null);
  return e ? json({ ok: true }) : fail("Enquiry not found", 404);
}
