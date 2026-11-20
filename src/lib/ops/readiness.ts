import "server-only";
import { db } from "@/lib/db";
import { resolveAppEnv } from "@/lib/env/app-env";
import { NotifyConfigError, resolveNotifyConfig } from "@/lib/env/notify-config";
import { OtpConfigError, resolveOtpConfig } from "@/lib/env/otp-config";
import { PaymentConfigError, resolvePaymentConfig } from "@/lib/env/payment-config";
import { MIN_CRON_SECRET } from "@/lib/env/security-config";
import { legacyLoginEnabled } from "@/lib/auth/admin";
import { resolveSeller } from "@/lib/tax/seller";
import { ORPHAN_REASONS } from "@/lib/payments/refunds";
import { site } from "@/config/site";

/**
 * Launch readiness and operational exceptions (M11 P3-T2/T4/T6, P4). One report for operators (`npm run ops:readiness`)
 * and owners (`GET /api/admin/readiness`): what is configured, what is still a business/operator decision, and what needs
 * a human now. It changes nothing and never prints secrets (only whether they are set). Statuses:
 *   ok        configured
 *   action    works, but a business/operator decision or setup is outstanding (the app is safe meanwhile)
 *   blocker   must be resolved before taking real customers on this environment
 */
export type CheckStatus = "ok" | "action" | "blocker";
export interface ReadinessCheck {
  id: string;
  area: "payments" | "jobs" | "email" | "shipping" | "tax" | "inventory" | "admin" | "operations";
  status: CheckStatus;
  summary: string;
  /** what to do, when status is not ok */
  next?: string;
}
export interface ReadinessReport {
  appEnv: string;
  generatedAt: string;
  overall: CheckStatus;
  checks: ReadinessCheck[];
}

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus => (a === "blocker" || b === "blocker" ? "blocker" : a === "action" || b === "action" ? "action" : "ok");

export async function collectReadiness(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<ReadinessReport> {
  let appEnv = "unknown";
  try {
    appEnv = resolveAppEnv(env);
  } catch {
    /* reported below as a blocker */
  }
  const deployed = appEnv === "production" || appEnv === "preview";
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  if (appEnv === "unknown") add({ id: "environment", area: "admin", status: "blocker", summary: "The environment (APP_ENV / VERCEL_ENV) cannot be resolved.", next: "Fix APP_ENV/VERCEL_ENV (env:check shows the reason)." });

  // payments
  try {
    const p = resolvePaymentConfig(env);
    add(
      p.onlinePayments
        ? { id: "payments.mode", area: "payments", status: "ok", summary: `Online payments on (${p.mode}).` }
        : { id: "payments.mode", area: "payments", status: "action", summary: `Online payments off (${p.mode}): customers can place pay-on-delivery/request orders only.`, next: "RELEASE.md E: Razorpay test-mode run, then the live launch checklist." },
    );
  } catch (e) {
    add({ id: "payments.mode", area: "payments", status: "blocker", summary: `Payment configuration is invalid${e instanceof PaymentConfigError ? `: ${e.issues.join(" ")}` : "."}`, next: "Fix the payment variables (npm run env:check)." });
  }

  // scheduled jobs
  const cron = (env.CRON_SECRET?.trim() ?? "").length >= MIN_CRON_SECRET;
  add(cron ? { id: "jobs.cron_secret", area: "jobs", status: "ok", summary: "CRON_SECRET is set: order expiry, reconciliation and the outbox can run on schedule." } : { id: "jobs.cron_secret", area: "jobs", status: deployed ? "blocker" : "action", summary: "CRON_SECRET is missing or shorter than 24 characters: scheduled jobs do nothing.", next: "Set CRON_SECRET (RELEASE.md A7) and confirm the Vercel plan runs the schedules." });

  // email
  try {
    const n = resolveNotifyConfig(env);
    add(n.mode === "smtp" ? { id: "email.notifications", area: "email", status: "ok", summary: `Order emails are sent by SMTP (${n.smtp?.host}).` } : { id: "email.notifications", area: "email", status: deployed ? "action" : "ok", summary: (n.mode === "mock" ? "Order emails go to the development mailbox only." : "Order emails are off: customers get no confirmation, dispatch or invoice emails.") + (deployed ? "" : " (fine for development/test)"), next: deployed ? "Choose an email provider, then set NOTIFY_MODE=smtp, SMTP_URL, EMAIL_FROM (ADR 0023)." : undefined });
  } catch (e) {
    add({ id: "email.notifications", area: "email", status: "blocker", summary: `Notification configuration is invalid${e instanceof NotifyConfigError ? `: ${e.issues.join(" ")}` : "."}` });
  }
  try {
    const o = resolveOtpConfig(env);
    add(o.mode === "email" ? { id: "email.sign_in", area: "email", status: "ok", summary: "Customer sign-in codes are emailed." } : { id: "email.sign_in", area: "email", status: deployed ? "action" : "ok", summary: (o.mode === "mock" ? "Sign-in codes go to the development outbox only." : "Customer sign-in is off (no code sender): accounts, order history and the wholesale portal are unavailable.") + (deployed ? "" : " (fine for development/test)"), next: deployed ? "Set CUSTOMER_OTP_MODE=email with the SMTP configuration (ADR 0023)." : undefined });
  } catch (e) {
    add({ id: "email.sign_in", area: "email", status: "blocker", summary: `Sign-in code configuration is invalid${e instanceof OtpConfigError ? `: ${e.issues.join(" ")}` : "."}` });
  }

  const [activeRules, taxRates, untracked, trackedActive, owners, deadMail, flagged, orphans, pendingRefunds, failedRefunds] = await Promise.all([
    db.shippingRule.count({ where: { active: true } }),
    db.taxRate.count(),
    db.variant.count({ where: { trackInventory: false, product: { active: true } } }),
    db.variant.count({ where: { trackInventory: true, product: { active: true } } }),
    db.adminUser.count({ where: { role: "owner", active: true } }),
    db.outboxMessage.count({ where: { status: "dead" } }),
    db.payment.count({ where: { needsReconciliation: true, OR: [{ reconcileReason: null }, { reconcileReason: { notIn: [...ORPHAN_REASONS] } }] } }),
    db.payment.count({ where: { status: "unpaid", providerPaymentId: { not: null }, reconcileReason: { in: [...ORPHAN_REASONS] } } }),
    db.refund.count({ where: { status: "pending", createdAt: { lt: new Date(now.getTime() - 60 * 60_000) } } }),
    db.refund.count({ where: { status: "failed", createdAt: { gt: new Date(now.getTime() - 30 * 24 * 3600_000) } } }),
  ]);

  // shipping (F12)
  add(activeRules > 0 ? { id: "shipping.rules", area: "shipping", status: "ok", summary: `${activeRules} active shipping rule(s): only matching pincodes are served.` } : { id: "shipping.rules", area: "shipping", status: "action", summary: `No active shipping rules: every pincode is accepted at the default delivery fee (₹${(site.delivery.fee / 100).toFixed(2)}), with charges confirmed by staff.`, next: "Staff-approved serviceable pincodes and fees, entered under Admin → shipping rules (ADR 0015)." });

  // tax (F14)
  const seller = resolveSeller(env);
  add(seller.ok ? { id: "tax.seller_gstin", area: "tax", status: "ok", summary: "SELLER_GSTIN is set and valid for the registered state." } : { id: "tax.seller_gstin", area: "tax", status: "action", summary: `Tax invoices cannot be issued: ${seller.issues.join(" ")}`, next: "Set SELLER_GSTIN (accountant)." });
  add(taxRates > 0 ? { id: "tax.rates", area: "tax", status: "ok", summary: `${taxRates} GST rate row(s) recorded.` } : { id: "tax.rates", area: "tax", status: "action", summary: "No GST rates recorded: orders carry no GST split and invoices cannot be issued.", next: "Enter accountant-approved rates per HSN (POST /api/admin/tax-rates, owner) and confirm the rounding rule." });

  // inventory (F11)
  add(untracked === 0 ? { id: "inventory.tracking", area: "inventory", status: "ok", summary: `All ${trackedActive} active variants are stock-tracked.` } : { id: "inventory.tracking", area: "inventory", status: "action", summary: `${untracked} active variant(s) use the manual in-stock flag (no oversell protection); ${trackedActive} tracked.`, next: "Count stock and run npm run inventory:import (RELEASE.md A8)." });

  // admin (F05)
  add(owners > 0 ? { id: "admin.owner", area: "admin", status: "ok", summary: `${owners} active owner account(s).` } : { id: "admin.owner", area: "admin", status: "blocker", summary: "No active owner account: nobody can manage staff, refunds or tax rates.", next: "npm run admin:bootstrap (RELEASE.md A1/A1b)." });
  const legacyOn = legacyLoginEnabled();
  add(!legacyOn ? { id: "admin.shared_password", area: "admin", status: "ok", summary: "The shared admin password login is off." } : { id: "admin.shared_password", area: "admin", status: "action", summary: "The shared admin password login is on (read-only, non-production only).", next: "Give staff individual accounts, then set ADMIN_LEGACY_LOGIN=off." });

  // operations (need a human now)
  add(deadMail === 0 ? { id: "ops.dead_letters", area: "operations", status: "ok", summary: "No undeliverable notifications." } : { id: "ops.dead_letters", area: "operations", status: "action", summary: `${deadMail} notification(s) could not be delivered after every retry.`, next: "Review them under Admin → notifications and retry once the cause is fixed (GET /api/admin/outbox?status=dead)." });
  add(orphans === 0 ? { id: "ops.orphan_captures", area: "operations", status: "ok", summary: "No captured payments waiting for a refund." } : { id: "ops.orphan_captures", area: "operations", status: "blocker", summary: `${orphans} captured payment(s) could not be applied to their order (customer charged): refund each one.`, next: "GET /api/admin/payments/exceptions, then an owner refunds through POST /api/admin/orders/[id]/refunds." });
  add(flagged === 0 ? { id: "ops.flagged_payments", area: "operations", status: "ok", summary: "No payment attempts awaiting reconciliation." } : { id: "ops.flagged_payments", area: "operations", status: "action", summary: `${flagged} payment attempt(s) await reconciliation with the gateway.`, next: "They settle on the next reconciliation run; if they persist, npm run payments:reconcile and check the gateway." });
  add(pendingRefunds + failedRefunds === 0 ? { id: "ops.refunds", area: "operations", status: "ok", summary: "No stuck or recently failed refunds." } : { id: "ops.refunds", area: "operations", status: "action", summary: `${pendingRefunds} refund(s) pending over an hour, ${failedRefunds} failed in the last 30 days.`, next: "GET /api/admin/payments/exceptions; failed refunds need a new refund request after the cause is known." });

  return { appEnv, generatedAt: now.toISOString(), overall: checks.reduce<CheckStatus>((a, c) => worst(a, c.status), "ok"), checks };
}

export interface PaymentException {
  kind: "orphan_capture" | "flagged_attempt" | "pending_refund" | "failed_refund";
  orderId: string;
  orderNumber: string;
  paymentId: string | null;
  refundId: string | null;
  amountPaise: number;
  reason: string | null;
  since: string;
}

/** Everything about money that needs a person (no customer contact data). Owners act on it through the refund API. */
export async function listPaymentExceptions(now = new Date(), limit = 100): Promise<PaymentException[]> {
  const order = { select: { id: true, number: true } } as const;
  const [orphans, flagged, pending, failed] = await Promise.all([
    db.payment.findMany({ where: { status: "unpaid", providerPaymentId: { not: null }, reconcileReason: { in: [...ORPHAN_REASONS] } }, include: { order }, orderBy: { createdAt: "asc" }, take: limit }),
    db.payment.findMany({ where: { needsReconciliation: true, OR: [{ reconcileReason: null }, { reconcileReason: { notIn: [...ORPHAN_REASONS] } }] }, include: { order }, orderBy: { createdAt: "asc" }, take: limit }),
    db.refund.findMany({ where: { status: "pending", createdAt: { lt: new Date(now.getTime() - 60 * 60_000) } }, include: { order }, orderBy: { createdAt: "asc" }, take: limit }),
    db.refund.findMany({ where: { status: "failed", createdAt: { gt: new Date(now.getTime() - 30 * 24 * 3600_000) } }, include: { order }, orderBy: { createdAt: "desc" }, take: limit }),
  ]);
  return [
    ...orphans.map((p) => ({ kind: "orphan_capture" as const, orderId: p.order.id, orderNumber: p.order.number, paymentId: p.id, refundId: null, amountPaise: p.amount, reason: p.reconcileReason, since: p.createdAt.toISOString() })),
    ...flagged.map((p) => ({ kind: "flagged_attempt" as const, orderId: p.order.id, orderNumber: p.order.number, paymentId: p.id, refundId: null, amountPaise: p.amount, reason: p.reconcileReason, since: p.createdAt.toISOString() })),
    ...pending.map((r) => ({ kind: "pending_refund" as const, orderId: r.order.id, orderNumber: r.order.number, paymentId: r.paymentId, refundId: r.id, amountPaise: r.amount, reason: null, since: r.createdAt.toISOString() })),
    ...failed.map((r) => ({ kind: "failed_refund" as const, orderId: r.order.id, orderNumber: r.order.number, paymentId: r.paymentId, refundId: r.id, amountPaise: r.amount, reason: r.failureCode, since: r.createdAt.toISOString() })),
  ];
}
