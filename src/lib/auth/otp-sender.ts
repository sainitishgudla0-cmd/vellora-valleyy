import "server-only";
import { log } from "@/lib/log";
import { OtpConfigError, resolveOtpConfig } from "@/lib/env/otp-config";
import { site } from "@/config/site";
import { sendSmtp } from "@/lib/notify/smtp";

/**
 * Delivery of sign-in codes (M5, ADR 0013; M11 P3-T1). Senders: a mock that cannot exist outside development/test, and
 * `email` (SMTP, `CUSTOMER_OTP_MODE=email`). With no valid sender `currentOtpSender()` returns null and sign-in answers 503:
 * it never "pretends" to send. The code is sent directly (not through the outbox: it must arrive now, and it is never stored).
 */
export interface OtpSender {
  readonly id: "mock" | "email";
  send(input: { email: string; code: string }): Promise<void>;
}

export interface OutboxEntry {
  email: string;
  code: string;
  at: Date;
}

const g = globalThis as unknown as { __mockOtpOutbox?: OutboxEntry[] };
/** In-process record of mock "sent" codes, for tests. Not reachable from any route. */
export const mockOtpOutbox: OutboxEntry[] = (g.__mockOtpOutbox ??= []);

const mockSender: OtpSender = {
  id: "mock",
  async send({ email, code }) {
    mockOtpOutbox.push({ email, code, at: new Date() });
    log.dev(`[mock-otp] sign-in code for ${email}: ${code} (development only)`);
  },
};

let lastLogged = "";
/** Plain text only: no links or tracking in a sign-in code email. */
export function otpEmail(code: string, ttlMinutes: number) {
  return {
    subject: `${code} is your ${site.name} sign-in code`,
    text: `Your ${site.name} sign-in code is ${code}.\n\nIt expires in ${ttlMinutes} minutes and works once. If you did not ask for it, ignore this email: nobody can sign in without the code.\n\n${site.name}`,
  };
}

export function currentOtpSender(): OtpSender | null {
  try {
    const c = resolveOtpConfig();
    if (c.mode === "mock") return mockSender;
    if (c.mode === "email" && c.smtp) {
      const smtp = c.smtp;
      return {
        id: "email",
        send: ({ email, code }) => sendSmtp(smtp, { to: email, ...otpEmail(code, 10), idempotencyKey: `otp:${email}:${code}:${Date.now()}` }),
      };
    }
    return null;
  } catch (e) {
    const msg = e instanceof OtpConfigError ? e.message : String(e);
    if (msg !== lastLogged) {
      lastLogged = msg;
      log.error("otp.config_invalid", { detail: msg, effect: "customer sign-in disabled" });
    }
    return null;
  }
}
