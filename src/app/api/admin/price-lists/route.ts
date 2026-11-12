import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/admin";
import { writeAudit } from "@/lib/auth/audit";
import { priceListCreateSchema } from "@/lib/wholesale/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "wholesale:read");
  if ("response" in auth) return auth.response;
  const lists = await db.priceList.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { items: true, accounts: true } } } });
  return json({ priceLists: lists.map((l) => ({ id: l.id, name: l.name, description: l.description, active: l.active, items: l._count.items, accounts: l._count.accounts })) });
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req, "pricing:write");
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(req, priceListCreateSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const l = await db.priceList.create({ data: parsed.data });
    await writeAudit({ action: "price_list.create", outcome: "success", admin: auth.admin, targetType: "price_list", targetId: l.id });
    return json({ priceList: { id: l.id, name: l.name, description: l.description, active: l.active } }, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await writeAudit({ action: "price_list.create", outcome: "rejected", admin: auth.admin, details: { code: "name_in_use" } });
      return Response.json({ error: "A price list with this name already exists", code: "name_in_use" }, { status: 409 });
    }
    throw e;
  }
}
