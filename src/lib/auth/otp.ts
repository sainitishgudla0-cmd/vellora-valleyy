import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { createCustomerSession, keyedHash } from "./customer";
import { currentOtpSender } from "./otp-sender";
import { PRIVACY_NOTICE_VERSION } from "@/lib/account/consent";

/**
 * Emailed one-time sign-in codes (M5-T2, ADR 0013).
 *  - 6 digits from a CSPRNG, valid 10 minutes, ONE live code per address (issuing a new one retires the old).
 *  - Brute force: at most MAX_ATTEMPTS guesses per code, at most MAX_PER_HOUR codes per address per hour and one per
 *    RESEND_COOLDOWN_S seconds, so an address can be guessed at ~25 times an hour against a 1-in-a-million code.
 *    Per-IP limits sit in front (route level).
 *  - Neither the address nor the code is stored in the clear; both are keyed hashes. The response never reveals whether
 *    an account exists.
 */
export const OTP_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_PER_HOUR = 5;
export const RESEND_COOLDOWN_S = 30;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const emailHash = (email: string) => keyedHash("customer-email", email);
const codeHash = (eh: string, code: string) => keyedHash("customer-otp", `${eh}:${code}`);
const safeEqualHex = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type IssueResult = { ok: true } | { ok: false; reason: "unavailable" | "cooldown" | "too_many"; retryAfterS?: number };

export async function issueOtp(emailInput: string, now = new Date()): Promise<IssueResult> {
  const sender = currentOtpSender();
  if (!sender) return { ok: false, reason: "unavailable" };
  const email = normalizeEmail(emailInput);
  const eh = emailHash(email);
  const recent = await db.otpChallenge.findMany({ where: { emailHash: eh, createdAt: { gt: new Date(now.getTime() - 3600_000) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (recent.length >= MAX_PER_HOUR) return { ok: false, reason: "too_many", retryAfterS: 600 };
  const sinceLast = recent[0] ? (now.getTime() - recent[0].createdAt.getTime()) / 1000 : Infinity;
  if (sinceLast < RESEND_COOLDOWN_S) return { ok: false, reason: "cooldown", retryAfterS: Math.ceil(RESEND_COOLDOWN_S - sinceLast) };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.$transaction([
    db.otpChallenge.updateMany({ where: { emailHash: eh, consumedAt: null }, data: { consumedAt: now } }), // only the newest code is live
    db.otpChallenge.create({ data: { emailHash: eh, codeHash: codeHash(eh, code), expiresAt: new Date(now.getTime() + OTP_TTL_MS) } }),
  ]);
  await sender.send({ email, code });
  await db.otpChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } }); // housekeeping
  return { ok: true };
}

export type VerifyResult =
  | { ok: true; token: string; customerId: string; created: boolean }
  | { ok: false; reason: "invalid" | "terms_required" };

export async function verifyOtp(
  input: { email: string; code: string; acceptTerms?: boolean; marketing?: boolean; userAgent?: string | null },
  now = new Date(),
): Promise<VerifyResult> {
  const email = normalizeEmail(input.email);
  const eh = emailHash(email);
  const challenge = await db.otpChallenge.findFirst({ where: { emailHash: eh, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
  if (!challenge) return { ok: false, reason: "invalid" };

  // Count the guess first (atomic, capped), so concurrent guesses cannot exceed the limit.
  const counted = await db.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (counted.count !== 1) return { ok: false, reason: "invalid" };
  if (!safeEqualHex(codeHash(eh, input.code), challenge.codeHash)) return { ok: false, reason: "invalid" };

  // The code is right: this person controls the address. Only now is it safe to say whether an account exists.
  const existing = await db.customer.findUnique({ where: { email }, select: { id: true } });
  if (!existing && !input.acceptTerms) return { ok: false, reason: "terms_required" }; // challenge stays live: they can retry with consent

  const used = await db.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
  if (used.count !== 1) return { ok: false, reason: "invalid" }; // lost a race with a parallel verification of the same code

  let customerId = existing?.id;
  let created = false;
  if (!customerId) {
    try {
      const c = await db.customer.create({
        data: {
          email,
          marketingConsent: !!input.marketing,
          consents: { create: [{ purpose: "terms_privacy", granted: true, version: PRIVACY_NOTICE_VERSION }, ...(input.marketing ? [{ purpose: "marketing", granted: true, version: PRIVACY_NOTICE_VERSION }] : [])] },
        },
        select: { id: true },
      });
      customerId = c.id;
      created = true;
    } catch {
      customerId = (await db.customer.findUnique({ where: { email }, select: { id: true } }))?.id; // created by a parallel request
    }
  }
  if (!customerId) return { ok: false, reason: "invalid" };
  await db.customer.update({ where: { id: customerId }, data: { lastLoginAt: now } });
  return { ok: true, token: await createCustomerSession(customerId, input.userAgent), customerId, created };
}
