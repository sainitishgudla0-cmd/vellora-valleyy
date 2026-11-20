import "server-only";
import crypto from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { SmtpConfig } from "@/lib/env/smtp-config";

/**
 * SMTP delivery (M11 P3-T1). One pooled-less transport per configuration (serverless instances are short-lived).
 * - TLS: implicit (smtps) or mandatory STARTTLS with certificate verification; plaintext only for a loopback catcher in
 *   development/test (`smtp-config.ts`).
 * - Idempotency: SMTP has no idempotency key, so the outbox dedupe key becomes a deterministic Message-ID. A send retried
 *   after a lost acknowledgement carries the same Message-ID, which providers and mail clients use to collapse duplicates.
 * - Errors are rethrown with a short, secret-free message (no URL, no credentials, no recipient), so the outbox can
 *   record and retry them.
 */
export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
}

export class SmtpSendError extends Error {
  constructor(public kind: "rejected" | "unavailable" | "tls" | "auth") {
    super(`smtp_${kind}`);
    this.name = "SmtpSendError";
  }
}

const transports = new Map<string, Transporter>();

function transportFor(c: SmtpConfig): Transporter {
  const key = JSON.stringify([c.host, c.port, c.secure, c.requireTLS, c.plaintext, c.auth?.user, c.auth?.pass]);
  let t = transports.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      requireTLS: c.requireTLS,
      ignoreTLS: c.plaintext,
      auth: c.auth ?? undefined,
      tls: c.plaintext ? undefined : { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      debug: false,
    });
    transports.set(key, t);
  }
  return t;
}

export const messageIdFor = (idempotencyKey: string, domain: string) => `<${crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}@${domain}>`;

function classify(e: unknown): SmtpSendError {
  const err = e as { code?: string; responseCode?: number };
  if (err?.code === "EAUTH") return new SmtpSendError("auth");
  if (err?.code === "ETLS" || /tls|certificate|ssl/i.test(String((e as Error)?.message ?? ""))) return new SmtpSendError("tls");
  if (typeof err?.responseCode === "number" && err.responseCode >= 500) return new SmtpSendError("rejected");
  return new SmtpSendError("unavailable");
}

export async function sendSmtp(c: SmtpConfig, m: SmtpMessage): Promise<void> {
  try {
    await transportFor(c).sendMail({
      from: c.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      messageId: messageIdFor(m.idempotencyKey, c.fromDomain),
      headers: { "X-Entity-Ref-ID": crypto.createHash("sha256").update(m.idempotencyKey).digest("hex").slice(0, 32) },
    });
  } catch (e) {
    throw classify(e);
  }
}

/** Test hook: forget cached transports (configuration changed between tests). */
export const resetSmtpTransports = () => {
  for (const t of transports.values()) t.close();
  transports.clear();
};
