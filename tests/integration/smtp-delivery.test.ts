/**
 * M11 P3-T1 (F09/F10): real SMTP delivery for order notifications (outbox) and customer sign-in codes, against an
 * in-process SMTP server on loopback (tests/support/fake-smtp.ts). Covers delivery, authentication, deterministic
 * Message-ID per outbox message, retry on temporary failure, a permanent refusal recorded without personal data, and
 * secret-free logs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { setLogSink, type LogRecord } from "@/lib/log";
import { processOutbox } from "@/lib/notify/dispatch";
import { messageIdFor, resetSmtpTransports } from "@/lib/notify/smtp";
import { issueOtp, verifyOtp } from "@/lib/auth/otp";
import { cleanupCustomerFixtures } from "../support/customer";
import { cleanupFulfilmentFixtures, fulfilmentEnv, placeCod } from "../support/fulfilment";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupFixtures } from "../support/mock-orders";
import { FakeSmtp, header } from "../support/fake-smtp";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as otpRoute } from "@/app/api/account/otp/request/route";

const PASSWORD = "smtp-secret-pass-77";
let smtp: FakeSmtp;
let variantId: string;
const logs: LogRecord[] = [];

beforeAll(async () => {
  smtp = await new FakeSmtp().start();
  variantId = (await createInventoryVariant({ stock: 50 })).variantId;
});
beforeEach(async () => {
  fulfilmentEnv();
  vi.stubEnv("NOTIFY_MODE", "smtp");
  vi.stubEnv("SMTP_URL", smtp.url("orders@velora.test", PASSWORD));
  vi.stubEnv("EMAIL_FROM", "Velora Valley <orders@velora.test>");
  vi.stubEnv("LOG_LEVEL", "debug");
  resetSmtpTransports();
  smtp.messages = [];
  logs.length = 0;
  setLogSink((r) => logs.push(r));
  await db.outboxMessage.deleteMany({});
});
afterAll(async () => {
  setLogSink(null);
  resetSmtpTransports();
  await smtp.stop();
  await db.outboxMessage.deleteMany({});
  await cleanupFulfilmentFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await cleanupFixtures();
  await db.$disconnect();
});

describe("order notifications over SMTP", () => {
  it("delivers the queued order email once, authenticated, with a Message-ID derived from the outbox key", async () => {
    const order = await placeCod(variantId, { email: "smoke.smtp-buyer@example.com" });
    const queued = await db.outboxMessage.findMany({ where: { subjectId: order.id } });
    expect(queued.map((m) => m.template)).toEqual(["order_placed"]);

    expect(await processOutbox()).toMatchObject({ sent: 1, retried: 0, dead: 0 });
    expect(smtp.messages).toHaveLength(1);
    const m = smtp.messages[0];
    expect(m.to).toEqual(["smoke.smtp-buyer@example.com"]);
    expect(m.from).toBe("orders@velora.test");
    expect(m.auth).toBe("orders@velora.test");
    expect(header(m.data, "Subject")).toContain(order.number);
    expect(header(m.data, "Message-ID")).toBe(messageIdFor(queued[0].dedupeKey, "velora.test"));

    expect(await processOutbox()).toMatchObject({ claimed: 0, sent: 0 }); // never sent twice
    expect(smtp.messages).toHaveLength(1);
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { id: queued[0].id } })).status).toBe("sent");
  });

  it("a temporary outage is retried later with the same Message-ID; nothing is lost", async () => {
    const order = await placeCod(variantId, { email: "smoke.smtp-retry@example.com" });
    smtp.dropConnections = 3; // nodemailer may retry the greeting on the same send
    const first = await processOutbox();
    expect(first).toMatchObject({ sent: 0, retried: 1 });
    const msg = await db.outboxMessage.findFirstOrThrow({ where: { subjectId: order.id } });
    expect(msg).toMatchObject({ status: "failed", attempts: 1 });
    expect(msg.lastError).toMatch(/^smtp_[a-z]+$/);
    smtp.dropConnections = 0;
    expect(await processOutbox({ now: new Date(Date.now() + 3600_000) })).toMatchObject({ sent: 1 });
    expect(header(smtp.messages.at(-1)!.data, "Message-ID")).toBe(messageIdFor(msg.dedupeKey, "velora.test"));
  });

  it("a refused recipient is recorded as a short code (no address, no server text) and retried per policy", async () => {
    const order = await placeCod(variantId, { email: "smoke.smtp-refused@example.com" });
    smtp.rejectRecipients = 1;
    expect(await processOutbox()).toMatchObject({ sent: 0, retried: 1 });
    const msg = await db.outboxMessage.findFirstOrThrow({ where: { subjectId: order.id } });
    expect(msg.lastError).toBe("smtp_rejected");
  });

  it("logs and stored errors never contain the SMTP password or URL", async () => {
    await placeCod(variantId, { email: "smoke.smtp-logs@example.com" });
    smtp.rejectRecipients = 1;
    await processOutbox();
    const all = JSON.stringify(logs) + JSON.stringify(await db.outboxMessage.findMany({ select: { lastError: true } }));
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("smtp://");
  });

  it("NOTIFY_MODE=smtp with an incomplete configuration sends nothing and keeps messages queued", async () => {
    vi.stubEnv("EMAIL_FROM", "");
    await placeCod(variantId, { email: "smoke.smtp-off@example.com" });
    expect(await processOutbox()).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0 });
    expect(smtp.messages).toHaveLength(0);
  });
});

describe("sign-in codes over SMTP (CUSTOMER_OTP_MODE=email)", () => {
  let liveBefore = 0;
  beforeEach(async () => {
    vi.stubEnv("CUSTOMER_OTP_MODE", "email");
    liveBefore = await db.otpChallenge.count({ where: { consumedAt: null, expiresAt: { gt: new Date() } } });
  });

  it("emails a 6-digit code that then signs the customer in; the code never appears in logs", async () => {
    const email = `smoke.smtp-otp-${Date.now()}@example.com`;
    expect(await issueOtp(email)).toEqual({ ok: true });
    expect(smtp.messages).toHaveLength(1);
    const body = smtp.messages[0].data;
    const code = /sign-in code is (\d{6})/.exec(body.replace(/=\r?\n/g, ""))?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(smtp.messages[0].to).toEqual([email]);
    expect(header(body, "Subject")).toContain(code!);
    expect(body).not.toMatch(/https?:\/\//); // no links in a code email
    expect(JSON.stringify(logs)).not.toContain(code!);
    const v = await verifyOtp({ email, code: code!, acceptTerms: true });
    expect(v.ok).toBe(true);
  });

  it("an SMTP failure is reported (503 + Retry-After), never as sent, and does not use up the customer's limits", async () => {
    const email = `smoke.smtp-otp-fail-${Date.now()}@example.com`;
    smtp.dropConnections = 3;
    const res = await otpRoute(new Request("http://localhost/api/account/otp/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await db.otpChallenge.count({ where: { consumedAt: null, expiresAt: { gt: new Date() } } })).toBe(liveBefore);
    smtp.dropConnections = 0;
    expect(await issueOtp(email)).toEqual({ ok: true }); // no cooldown left behind by the failed attempt
    expect(smtp.messages.at(-1)!.to).toEqual([email]);
  });
});
