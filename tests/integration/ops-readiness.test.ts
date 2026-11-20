/**
 * M11 readiness report and payment exceptions: reflects configuration and data, needs an admin session, never leaks
 * secrets or customer contact data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { collectReadiness, listPaymentExceptions } from "@/lib/ops/readiness";
import { cleanupAdminFixtures, createTestAdmin } from "../support/admin";
import { cleanupFixtures, createRazorpayOrderWithAttempt } from "../support/mock-orders";

import { GET as readinessRoute } from "@/app/api/admin/readiness/route";
import { GET as exceptionsRoute } from "@/app/api/admin/payments/exceptions/route";

let viewer: Awaited<ReturnType<typeof createTestAdmin>>;
const get = (fn: (r: Request) => Promise<Response>, cookie?: string) => fn(new Request("http://localhost/api/admin/x", { headers: cookie ? { cookie } : {} }));
const check = (r: Awaited<ReturnType<typeof collectReadiness>>, id: string) => r.checks.find((c) => c.id === id)!;
const SECRET_SMTP = "smtps://user:readiness-secret-pass@mail.example.com";

beforeAll(async () => {
  viewer = await createTestAdmin("viewer");
});
afterAll(async () => {
  await db.shippingRule.deleteMany({ where: { name: { startsWith: "readiness-test" } } });
  await cleanupFixtures();
  await cleanupAdminFixtures();
  await db.$disconnect();
});

describe("routes", () => {
  it("need an admin session; any role may read", async () => {
    expect((await get(readinessRoute)).status).toBe(401);
    expect((await get(exceptionsRoute)).status).toBe(401);
    const r = await get(readinessRoute, viewer.cookie);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.checks.length).toBeGreaterThan(10);
    expect(["ok", "action", "blocker"]).toContain(body.overall);
    expect((await get(exceptionsRoute, viewer.cookie)).status).toBe(200);
  });
});

describe("report", () => {
  it("production without CRON_SECRET is a blocker; with it the job check is ok; secrets are never echoed", async () => {
    const base = { VERCEL_ENV: "production", NOTIFY_MODE: "smtp", SMTP_URL: SECRET_SMTP, EMAIL_FROM: "Velora <orders@example.com>" } as unknown as NodeJS.ProcessEnv;
    const without = await collectReadiness(base);
    expect(check(without, "jobs.cron_secret").status).toBe("blocker");
    expect(without.overall).toBe("blocker");
    const withSecret = await collectReadiness({ ...base, CRON_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv);
    expect(check(withSecret, "jobs.cron_secret").status).toBe("ok");
    expect(check(withSecret, "email.notifications")).toMatchObject({ status: "ok", summary: expect.stringContaining("mail.example.com") });
    expect(JSON.stringify(withSecret)).not.toContain("readiness-secret-pass");
    expect(JSON.stringify(withSecret)).not.toContain("x".repeat(32));
  });

  it("off email and sign-in are actions in a deployment, invalid configuration is a blocker", async () => {
    const r = await collectReadiness({ VERCEL_ENV: "preview", CRON_SECRET: "x".repeat(32) } as unknown as NodeJS.ProcessEnv);
    expect(check(r, "email.notifications").status).toBe("action");
    expect(check(r, "email.sign_in").status).toBe("action");
    const bad = await collectReadiness({ VERCEL_ENV: "production", NOTIFY_MODE: "mock" } as unknown as NodeJS.ProcessEnv);
    expect(check(bad, "email.notifications").status).toBe("blocker");
  });

  it("shipping rules: no active rule is an action; an active rule makes it ok", async () => {
    const active = await db.shippingRule.count({ where: { active: true } });
    if (active === 0) expect(check(await collectReadiness(), "shipping.rules").status).toBe("action");
    await db.shippingRule.create({ data: { name: "readiness-test rule", pincodePrefix: "999", serviceable: true, fee: 0, active: true } });
    expect(check(await collectReadiness(), "shipping.rules").status).toBe("ok");
    await db.shippingRule.deleteMany({ where: { name: { startsWith: "readiness-test" } } });
  });

  it("an orphan capture is a blocker and is listed as an exception with its order number and amount only", async () => {
    const f = await createRazorpayOrderWithAttempt({ status: "cancelled", paymentStatus: "failed", total: 73000 });
    await db.payment.create({ data: { orderId: f.order.id, provider: "razorpay", mode: "razorpay_test", providerOrderId: f.providerOrderId, providerPaymentId: `pay_readiness${Date.now()}`, amount: 73000, currency: "INR", status: "unpaid", needsReconciliation: true, reconcileReason: "captured_on_cancelled_order" } });
    const r = await collectReadiness();
    expect(check(r, "ops.orphan_captures").status).toBe("blocker");
    const ex = (await listPaymentExceptions()).filter((e) => e.orderId === f.order.id);
    expect(ex).toEqual([expect.objectContaining({ kind: "orphan_capture", orderNumber: f.order.number, amountPaise: 73000, reason: "captured_on_cancelled_order" })]);
    // the orphan is not double-counted as an attempt awaiting reconciliation
    expect(ex.filter((e) => e.kind === "flagged_attempt")).toHaveLength(0);
    const body = await (await get(exceptionsRoute, viewer.cookie)).json();
    const row = body.exceptions.find((e: { orderId: string }) => e.orderId === f.order.id);
    expect(Object.keys(row).sort()).toEqual(["amountPaise", "kind", "orderId", "orderNumber", "paymentId", "reason", "refundId", "since"]);
  });

  it("an unresolvable environment is a blocker, not a crash", async () => {
    vi.stubEnv("APP_ENV", "staging-ish");
    const r = await collectReadiness({ APP_ENV: "staging-ish" } as unknown as NodeJS.ProcessEnv);
    expect(check(r, "environment").status).toBe("blocker");
  });
});
