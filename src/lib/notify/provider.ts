import "server-only";
import { log } from "@/lib/log";
import { NotifyConfigError, resolveNotifyConfig } from "@/lib/env/notify-config";
import { sendSmtp } from "./smtp";

/**
 * Email delivery (M7-T5, M11 P3-T1). Providers: the MOCK (no network code; an in-process mailbox, development/test only) and
 * SMTP (`NOTIFY_MODE=smtp`, `smtp.ts`) to whichever provider the business configures. With `NOTIFY_MODE` unset or invalid,
 * `currentEmailProvider()` returns null and nothing is queued or sent.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** stable per message: a real provider uses it to deduplicate a retried send */
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly id: "mock" | "smtp";
  send(mail: OutgoingEmail): Promise<void>;
}

export interface MailboxEntry extends OutgoingEmail {
  at: Date;
}

const g = globalThis as unknown as { __mockMailbox?: MailboxEntry[]; __mockMailFail?: { remaining: number; message: string } | null };
/** Everything the mock "sent". For tests; not reachable from any route. */
export const mockMailbox: MailboxEntry[] = (g.__mockMailbox ??= []);

/** Test hook: make the next `times` sends fail, to exercise retries. */
export function failNextMockSends(times: number, message = "provider_unavailable") {
  g.__mockMailFail = times > 0 ? { remaining: times, message } : null;
}

const mock: EmailProvider = {
  id: "mock",
  async send(mail) {
    const f = g.__mockMailFail;
    if (f && f.remaining > 0) {
      f.remaining--;
      throw new Error(f.message);
    }
    mockMailbox.push({ ...mail, at: new Date() });
    log.dev(`[mock-mail] to=${mail.to} subject="${mail.subject}" (development only, not sent)`);
  },
};

export function currentEmailProvider(): EmailProvider | null {
  try {
    const c = resolveNotifyConfig();
    if (c.mode === "mock") return mock;
    if (c.mode === "smtp" && c.smtp) {
      const smtp = c.smtp;
      return { id: "smtp", send: (mail) => sendSmtp(smtp, mail) };
    }
    return null;
  } catch (e) {
    if (!(e instanceof NotifyConfigError)) throw e;
    log.error("notify.config_invalid", { detail: e.message, effect: "notifications disabled" });
    return null;
  }
}

export function notificationsEnabled(): boolean {
  return currentEmailProvider() !== null;
}
