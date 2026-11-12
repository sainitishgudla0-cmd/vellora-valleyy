/**
 * Development/test runner for the mock payment flow (M2-T5, ADR 0009):
 *   PAYMENT_MODE=mock MOCK_PAYMENT_CONFIRM_KEY=<24+ chars> (set on BOTH the server and this process) \
 *   BASE_URL=http://127.0.0.1:3000 TEST_TARGET=disposable npm run payments:mock-checkout
 *
 * Places a mock order through the real POST /api/orders, then confirms it through the real, key-protected
 * POST /api/payments/mock/confirm. The confirm key is read from this server-side process only: it is never
 * sent to a browser or printed, and the storefront has no code path that holds it. Refuses to run against any
 * server that does not prove it is a disposable test environment. Creates a "SMOKE TEST" order (mock: no money).
 */
import { mockProof } from "../src/lib/payments/providers/mock";
import { MOCK_CONFIRM_HEADER } from "../src/lib/payments/labels";
import { assertServerIsDisposable, loadLocalEnv } from "./lib/safety";

loadLocalEnv();
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function call(path: string, init: { json?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(BASE + path, {
    method: init.json === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function main() {
  const key = process.env.MOCK_PAYMENT_CONFIRM_KEY?.trim();
  if (!key || key.length < 24) throw new Error("MOCK_PAYMENT_CONFIRM_KEY (24+ characters) must be set in this process.");
  await assertServerIsDisposable(BASE);

  const products = await call("/api/products");
  const variantId: string | undefined = products.body.products?.[0]?.variants?.[0]?.id;
  if (!variantId) throw new Error("No catalogue found. Run `npm run db:seed` on the disposable database first.");

  const created = await call("/api/orders", {
    json: {
      customerName: "SMOKE TEST Mock Runner", email: "smoke.mock-runner@example.com", phone: "9876543210",
      addressLine1: "12 Test Street, Test Nagar", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002",
      paymentMethod: "razorpay", items: [{ variantId, quantity: 1 }],
    },
  });
  if (created.status !== 201 || created.body.payment?.provider !== "mock") {
    throw new Error(`Order was not created as a mock order (HTTP ${created.status}). Is the server running with PAYMENT_MODE=mock?`);
  }
  const { number, token } = created.body.order as { number: string; token: string };
  const proof = mockProof(created.body.payment.orderId);

  const confirm = await call("/api/payments/mock/confirm", {
    headers: { [MOCK_CONFIRM_HEADER]: key },
    json: { orderNumber: number, token, providerOrderId: proof.providerOrderId, providerPaymentId: proof.providerPaymentId, signature: proof.signature },
  });
  if (confirm.status !== 200 || confirm.body.ok !== true) throw new Error(`Mock confirmation failed (HTTP ${confirm.status}).`);
  console.log(`[mock-checkout] order ${number}: created as mock and confirmed (${confirm.body.label}).`);

  const again = await call("/api/payments/mock/confirm", {
    headers: { [MOCK_CONFIRM_HEADER]: key },
    json: { orderNumber: number, token, providerOrderId: proof.providerOrderId, providerPaymentId: proof.providerPaymentId, signature: proof.signature },
  });
  if (again.body.alreadyConfirmed !== true) throw new Error("Repeat confirmation was not idempotent.");
  console.log("[mock-checkout] repeat confirmation is idempotent.");
}

main().catch((e) => {
  console.error(`[mock-checkout] ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
});
