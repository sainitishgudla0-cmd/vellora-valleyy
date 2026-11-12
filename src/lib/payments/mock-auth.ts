import "server-only";
import { safeEqual } from "@/lib/payment-verification";

/**
 * Development/test-only authorisation for the mock confirmation endpoint.
 * The endpoint requires a shared secret in `x-mock-confirm-key` matching MOCK_PAYMENT_CONFIRM_KEY (24+ chars).
 * Without the variable the endpoint does not exist (404). The mode check alone is never authorisation.
 */
export const MOCK_CONFIRM_HEADER = "x-mock-confirm-key";
const MIN_KEY_LENGTH = 24;

export function mockConfirmKeyConfigured(env: NodeJS.ProcessEnv = process.env) {
  return (env.MOCK_PAYMENT_CONFIRM_KEY?.trim().length ?? 0) >= MIN_KEY_LENGTH;
}

export function mockConfirmKeyValid(presented: string | null, env: NodeJS.ProcessEnv = process.env) {
  const key = env.MOCK_PAYMENT_CONFIRM_KEY?.trim();
  if (!key || key.length < MIN_KEY_LENGTH || !presented) return false;
  return safeEqual(presented, key);
}
