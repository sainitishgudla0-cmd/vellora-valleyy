import "server-only";
import { NotifyConfigError, resolveNotifyConfig } from "@/lib/env/notify-config";

/**
 * Email delivery (M7-T5). The only provider today is a MOCK with NO network code at all: it appends to an in-process mailbox.
 * Nothing can reach a real recipient from development or test; in preview/production `currentEmailProvider()` returns null
 * (notifications are off) until a real adapter is written and the config allows it.
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
  readonly id: "mock";
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
    if (process.env.NODE_ENV !== "test") console.info(`[mock-mail] to=${mail.to} subject="${mail.subject}" (development only, not sent)`);
  },
};

export function currentEmailProvider(): EmailProvider | null {
  try {
    return resolveNotifyConfig().mode === "mock" ? mock : null;
  } catch (e) {
    if (!(e instanceof NotifyConfigError)) throw e;
    console.error(`[notify] ${e.message} Notifications are disabled.`);
    return null;
  }
}

export function notificationsEnabled(): boolean {
  return currentEmailProvider() !== null;
}
