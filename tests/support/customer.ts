/**
 * Test-only customer fixtures: real sign-in through the real OTP service with the mock sender, so tests exercise the
 * production path. Never imported by application code.
 */
import { vi } from "vitest";
import { db } from "@/lib/db";
import { CUSTOMER_COOKIE } from "@/lib/auth/customer";
import { issueOtp, verifyOtp } from "@/lib/auth/otp";
import { mockOtpOutbox } from "@/lib/auth/otp-sender";
import { ensureSessionSecret } from "./admin";

export const CUSTOMER_FIXTURE_DOMAIN = "m5-fixture.example.com";
let seq = 0;
const tag = Date.now().toString(36);

export function customerTestEnv() {
  ensureSessionSecret();
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("CUSTOMER_OTP_MODE", "mock");
}

export const freshEmail = (name = "shopper") => `${name}-${tag}-${++seq}@${CUSTOMER_FIXTURE_DOMAIN}`;

/** The newest mock-delivered code for an address. */
export function lastCode(email: string): string {
  const e = [...mockOtpOutbox].reverse().find((o) => o.email === email);
  if (!e) throw new Error(`no code was sent to ${email}`);
  return e.code;
}

/** Signs a customer in (creating the account on first use). `ageMs` backdates the session for recency tests. */
export async function signInCustomer(email = freshEmail(), opts: { ageMs?: number } = {}) {
  customerTestEnv();
  const issued = await issueOtp(email);
  if (!issued.ok) throw new Error(`fixture sign-in: ${issued.reason}`);
  const r = await verifyOtp({ email, code: lastCode(email), acceptTerms: true, userAgent: "vitest" });
  if (!r.ok) throw new Error(`fixture sign-in: ${r.reason}`);
  if (opts.ageMs) {
    await db.customerSession.updateMany({ where: { customerId: r.customerId }, data: { createdAt: new Date(Date.now() - opts.ageMs) } });
  }
  return { email, customerId: r.customerId, token: r.token, cookie: `${CUSTOMER_COOKIE}=${r.token}` };
}

export async function cleanupCustomerFixtures() {
  const customers = await db.customer.findMany({ where: { email: { endsWith: `@${CUSTOMER_FIXTURE_DOMAIN}` } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await db.order.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { email: { endsWith: `@${CUSTOMER_FIXTURE_DOMAIN}` } }, { email: "erased@erased.invalid" }] } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
  await db.otpChallenge.deleteMany({});
  await db.auditLog.deleteMany({ where: { actorLabel: { startsWith: "customer:" } } });
  await db.enquiry.deleteMany({ where: { OR: [{ email: { endsWith: `@${CUSTOMER_FIXTURE_DOMAIN}` } }, { email: "erased@erased.invalid" }] } });
  await db.subscriber.deleteMany({ where: { email: { endsWith: `@${CUSTOMER_FIXTURE_DOMAIN}` } } });
  mockOtpOutbox.length = 0;
}
