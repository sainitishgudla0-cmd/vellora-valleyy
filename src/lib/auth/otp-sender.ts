import "server-only";
import { OtpConfigError, resolveOtpConfig } from "@/lib/env/otp-config";

/**
 * Delivery of sign-in codes (M5, ADR 0013). The only sender until M7 is a mock that cannot exist outside
 * development/test: `currentOtpSender()` returns null there (sign-in then answers 503, it never "pretends" to send).
 */
export interface OtpSender {
  readonly id: "mock";
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
    if (process.env.NODE_ENV !== "test") console.info(`[mock-otp] sign-in code for ${email}: ${code} (development only)`);
  },
};

let lastLogged = "";
export function currentOtpSender(): OtpSender | null {
  try {
    return resolveOtpConfig().mode === "mock" ? mockSender : null;
  } catch (e) {
    const msg = e instanceof OtpConfigError ? e.message : String(e);
    if (msg !== lastLogged) {
      lastLogged = msg;
      console.error(`[otp] ${msg} Customer sign-in is disabled.`);
    }
    return null;
  }
}
