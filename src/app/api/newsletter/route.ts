import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { newsletterSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!(await rateLimit("newsletter", 8, 10 * 60_000))) return fail("Too many attempts. Please try again later.", 429);
  const parsed = await parseBody(req, newsletterSchema);
  if ("response" in parsed) return parsed.response;
  await db.subscriber.upsert({ where: { email: parsed.data.email }, create: { email: parsed.data.email }, update: {} });
  return json({ ok: true }, 201);
}
