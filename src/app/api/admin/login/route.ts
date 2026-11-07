import { z } from "zod";
import { fail, json, parseBody } from "@/lib/api";
import { adminConfigured, checkPassword, createSessionCookie } from "@/lib/admin-auth";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!adminConfigured()) return fail("Admin is not configured. Set ADMIN_PASSWORD and SESSION_SECRET.", 503);
  if (!(await rateLimit("admin-login", 8, 15 * 60_000))) return fail("Too many attempts. Try again later.", 429);
  const parsed = await parseBody(req, z.object({ password: z.string().min(1).max(200) }));
  if ("response" in parsed) return parsed.response;
  if (!checkPassword(parsed.data.password)) return fail("Incorrect password", 401);
  await createSessionCookie();
  return json({ ok: true });
}
