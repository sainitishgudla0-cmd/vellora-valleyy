import { fail, json, parseBody } from "@/lib/api";
import { requireBusiness } from "@/lib/wholesale/auth";
import { failure } from "@/lib/wholesale/http";
import { listBuyerQuotes, requestQuote } from "@/lib/wholesale/quotes";
import { quoteRequestSchema } from "@/lib/wholesale/schemas";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  return json({ quotes: await listBuyerQuotes(auth.account.id) });
}

/** Ask for prices on a basket (MOQ / case packs checked). Staff price it; no price is shown until they do. */
export async function POST(req: Request) {
  const auth = await requireBusiness(req);
  if ("response" in auth) return auth.response;
  if (!(await rateLimit("business-quote", 20, 60 * 60_000))) return fail("Too many requests. Please try again later.", 429);
  const parsed = await parseBody(req, quoteRequestSchema);
  if ("response" in parsed) return parsed.response;
  const r = await requestQuote(auth.account, parsed.data);
  return r.ok ? json({ quote: r.quote }, 201) : failure(r);
}
