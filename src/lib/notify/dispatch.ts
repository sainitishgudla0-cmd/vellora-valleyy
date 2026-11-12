import "server-only";
import { db } from "@/lib/db";
import { site } from "@/config/site";
import { renderTemplate, TEMPLATES, type TemplateName, type TemplateVars } from "./templates";
import { currentEmailProvider } from "./provider";

/**
 * Outbox dispatcher (M7-T5). `processOutbox` claims due messages one by one with a conditional update (so parallel workers never
 * send the same message twice), renders each from the database, sends through the provider and records the outcome:
 *   success -> sent; failure -> retry with backoff (1 min, 5 min, 30 min, 2 h, 6 h); after MAX_ATTEMPTS -> dead (kept for staff).
 * A message stuck in `sending` (a crashed worker) is reclaimed after CLAIM_TIMEOUT_MS. Messages to erased customers are dropped.
 * Nothing is ever sent unless a provider is configured (never in preview/production today, see notify-config).
 */
export const MAX_ATTEMPTS = 6;
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000] as const;
export const CLAIM_TIMEOUT_MS = 10 * 60_000;
const ERASED = "erased@erased.invalid";

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
}

export const backoffFor = (attemptsSoFar: number) => BACKOFF_MS[Math.min(attemptsSoFar, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];

class Dropped extends Error {}

async function build(template: string, subjectType: string, subjectId: string): Promise<{ to: string; vars: TemplateVars; name: TemplateName }> {
  if (!(TEMPLATES as readonly string[]).includes(template)) throw new Dropped("unknown_template");
  const name = template as TemplateName;
  const brand = site.name;
  if (subjectType === "quote") {
    const q = await db.quote.findUnique({ where: { id: subjectId }, include: { businessAccount: { select: { contactEmail: true, contactName: true } } } });
    if (!q) throw new Dropped("subject_missing");
    if (q.businessAccount.contactEmail === ERASED) throw new Dropped("no_recipient");
    return { name, to: q.businessAccount.contactEmail, vars: { brand, customerName: q.businessAccount.contactName, quoteNumber: q.number, quoteTotal: q.total ?? undefined, quoteValidUntil: q.validUntil?.toISOString().slice(0, 10) } };
  }
  const o = await db.order.findUnique({ where: { id: subjectId }, include: { items: { orderBy: { id: "asc" } }, shipments: { orderBy: { createdAt: "desc" }, take: 1 }, invoice: { select: { number: true } } } });
  if (!o) throw new Dropped("subject_missing");
  if (o.email === ERASED) throw new Dropped("no_recipient");
  const ship = o.shipments[0];
  return {
    name,
    to: o.email,
    vars: {
      brand,
      customerName: o.customerName,
      orderNumber: o.number,
      orderUrl: `${site.url}/order/${o.number}?t=${o.accessToken}`,
      total: o.total,
      items: o.items.map((i) => ({ name: i.productName, label: i.variantLabel, quantity: i.quantity })),
      courier: ship?.courier,
      awb: ship?.awb,
      trackingUrl: ship?.trackingUrl,
      invoiceNumber: o.invoice?.number,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
    },
  };
}

export async function processOutbox(opts: { limit?: number; now?: Date } = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0 };
  const provider = currentEmailProvider();
  if (!provider) return summary; // notifications are off: leave everything untouched
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? 50, 200);
  const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS);

  // Claim each due message with a conditional update (status guard in the WHERE): of several workers racing for one message
  // exactly one sees count 1 and sends it. (Typed queries on purpose: raw date comparisons depend on the database session's timezone.)
  const due = await db.outboxMessage.findMany({
    where: { OR: [{ status: { in: ["pending", "failed"] }, nextAttemptAt: { lte: now } }, { status: "sending", claimedAt: { lt: stale } }] },
    orderBy: { nextAttemptAt: "asc" },
    take: limit * 2,
  });
  const claimed: typeof due = [];
  for (const m of due) {
    if (claimed.length >= limit) break;
    const won = await db.outboxMessage.updateMany({ where: { id: m.id, status: m.status, ...(m.status === "sending" ? { claimedAt: m.claimedAt } : { nextAttemptAt: m.nextAttemptAt }) }, data: { status: "sending", claimedAt: now } });
    if (won.count === 1) claimed.push(m);
  }
  summary.claimed = claimed.length;

  for (const m of claimed) {
    try {
      const { to, vars, name } = await build(m.template, m.subjectType, m.subjectId);
      const mail = renderTemplate(name, vars);
      await provider.send({ to, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: m.dedupeKey });
      await db.outboxMessage.updateMany({ where: { id: m.id, status: "sending" }, data: { status: "sent", sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      summary.sent++;
    } catch (e) {
      if (e instanceof Dropped) {
        await db.outboxMessage.updateMany({ where: { id: m.id, status: "sending" }, data: { status: "dead", lastError: e.message } });
        summary.skipped++;
        continue;
      }
      const attempts = m.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      // the error text is reduced to a short code: provider messages can contain the recipient
      const code = e instanceof Error && /^[a-z_]{3,40}$/.test(e.message) ? e.message : "send_failed";
      await db.outboxMessage.updateMany({ where: { id: m.id, status: "sending" }, data: { status: dead ? "dead" : "failed", attempts, lastError: code, nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)) } });
      if (dead) summary.dead++;
      else summary.retried++;
    }
  }
  return summary;
}
