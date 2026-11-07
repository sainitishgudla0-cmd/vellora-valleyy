import { db } from "@/lib/db";
import { fail, json, parseBody } from "@/lib/api";
import { enquirySchema } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!(await rateLimit("enquiries", 6, 10 * 60_000))) return fail("Too many messages. Please wait a few minutes and try again.", 429);
  const parsed = await parseBody(req, enquirySchema);
  if ("response" in parsed) return parsed.response;
  const { website, ...data } = parsed.data;
  if (website) return json({ ok: true }, 201); // honeypot: silently ignore bots
  const e = await db.enquiry.create({
    data: {
      type: data.type,
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      company: data.company || null,
      city: data.city || null,
      interest: data.type === "business" ? data.interest ?? null : null,
      message: data.message,
    },
  });
  return json({ ok: true, id: e.id }, 201);
}
