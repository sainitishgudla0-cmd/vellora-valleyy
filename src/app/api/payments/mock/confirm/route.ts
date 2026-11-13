import { z } from "zod";
import { log } from "@/lib/log";
import { fail, json, parseBody } from "@/lib/api";
import { safePaymentConfig } from "@/lib/payments";
import { confirmMockPayment } from "@/lib/payments/mock-confirm";
import { MOCK_CONFIRM_HEADER, mockConfirmKeyConfigured, mockConfirmKeyValid } from "@/lib/payments/mock-auth";
import { MOCK_PAYMENT_LABEL } from "@/lib/payments/labels";
import { rateLimit } from "@/lib/rate-limit";

// strict: a client cannot smuggle in a provider, mode, amount or status
const schema = z.strictObject({
  orderNumber: z.string().min(1).max(40),
  token: z.string().min(1).max(100),
  providerOrderId: z.string().min(1).max(80),
  providerPaymentId: z.string().min(1).max(80),
  signature: z.string().min(1).max(200),
});

const NOT_FOUND = () => fail("Not found", 404);
const CONFLICT = "This mock payment cannot be applied to the order in its current state. No changes were made.";

/** Contract: docs/API-CONTRACTS.md#mock-payment-confirm. Development/test only (ADR 0008). */
export async function POST(req: Request) {
  // 1. The route does not exist unless the server's own configuration says mock mode in development/test.
  const cfg = safePaymentConfig();
  if (!cfg || cfg.mode !== "mock" || (cfg.appEnv !== "development" && cfg.appEnv !== "test")) return NOT_FOUND();
  if (!mockConfirmKeyConfigured()) return NOT_FOUND();

  // 2. Throttle before any secret comparison.
  if (!(await rateLimit("mock-confirm", 30, 10 * 60_000))) return fail("Too many attempts. Please wait a few minutes and try again.", 429);

  // 3. Mode alone is not authorisation: a dev/test shared secret is required.
  if (!mockConfirmKeyValid(req.headers.get(MOCK_CONFIRM_HEADER))) return fail("Unauthorized", 401);

  const parsed = await parseBody(req, schema);
  if ("response" in parsed) return parsed.response;

  const result = await confirmMockPayment(parsed.data, cfg);
  switch (result.kind) {
    case "confirmed":
      return json({ ok: true, mock: true, label: MOCK_PAYMENT_LABEL });
    case "already_confirmed":
      return json({ ok: true, alreadyConfirmed: true, mock: true, label: MOCK_PAYMENT_LABEL });
    case "not_found":
      return NOT_FOUND();
    case "invalid_proof":
      return fail("Mock payment proof is invalid. No changes were made.", 400);
    case "conflict":
      // log the order number and reason only: never the token, signature or customer details
      log.error("payments.mock_confirm_conflict", { order: parsed.data.orderNumber, reason: result.reason });
      return fail(CONFLICT, 409);
  }
}
