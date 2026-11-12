/**
 * Deterministic in-memory stand-in for api.razorpay.com. Tests install it over global fetch; any request to
 * another host (or an unknown path) throws, so a test can never reach a real payment service.
 */
import crypto from "node:crypto";
import { vi } from "vitest";

export const TEST_KEY_ID = "rzp_test_fake123456";
export const TEST_KEY_SECRET = "fake_secret_for_tests_only";

export type CreateBehaviour = "ok" | "timeout" | "http500" | "http400" | "http429" | "wrongAmount" | "wrongCurrency" | "badBody" | "lostResponse";

export interface FakePayment { id: string; order_id: string | null; status: string; amount: number; currency: string }

let globalSeq = 0; // unique across instances: gateway ids are unique columns in the database
const runTag = Date.now().toString(36);

export class FakeRazorpay {
  createBehaviour: CreateBehaviour = "ok";
  orders = new Map<string, { id: string; amount: number; currency: string; receipt: string; status: string }>();
  payments = new Map<string, FakePayment>();
  /** `GET /payments/:id` can be forced to fail like a network problem. */
  paymentLookup: "ok" | "timeout" | "http500" = "ok";
  calls: string[] = [];

  install() {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => this.handle(String(input), init)));
    return this;
  }

  /** Registers a gateway payment for a gateway order, as if the customer paid in the Razorpay window. */
  addPayment(orderId: string, status: string, over: Partial<FakePayment> = {}): FakePayment {
    const o = this.orders.get(orderId);
    const p: FakePayment = { id: `pay_fake${runTag}${String(++globalSeq).padStart(5, "0")}`, order_id: orderId, status, amount: o?.amount ?? 0, currency: o?.currency ?? "INR", ...over };
    this.payments.set(p.id, p);
    return p;
  }

  signature(orderId: string, paymentId: string, secret = TEST_KEY_SECRET) {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    if (u.host !== "api.razorpay.com") throw new Error(`BLOCKED network call to ${u.host}: tests must not reach real services`);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    const path = u.pathname.replace(/^\/v1/, "");

    if (method === "POST" && path === "/orders") {
      const body = JSON.parse(String(init?.body));
      switch (this.createBehaviour) {
        case "timeout": throw new DOMException("timed out", "TimeoutError");
        case "http500": return this.json({ error: {} }, 500);
        case "http429": return this.json({ error: {} }, 429);
        case "http400": return this.json({ error: { description: "bad" } }, 400);
        case "badBody": return new Response("<html>oops</html>", { status: 200 });
      }
      const amount = this.createBehaviour === "wrongAmount" ? body.amount + 1 : body.amount;
      const currency = this.createBehaviour === "wrongCurrency" ? "USD" : body.currency;
      const o = { id: `order_fake${runTag}${String(++globalSeq).padStart(5, "0")}`, amount, currency, receipt: body.receipt, status: "created" };
      this.orders.set(o.id, o);
      if (this.createBehaviour === "lostResponse") throw new DOMException("connection reset after the gateway created the order", "NetworkError");
      return this.json(o);
    }
    let m = /^\/payments\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      if (this.paymentLookup === "timeout") throw new DOMException("timed out", "TimeoutError");
      if (this.paymentLookup === "http500") return this.json({}, 500);
      const p = this.payments.get(decodeURIComponent(m[1]));
      return p ? this.json(p) : this.json({ error: {} }, 404);
    }
    m = /^\/orders\/([^/]+)\/payments$/.exec(path);
    if (method === "GET" && m) return this.json({ items: [...this.payments.values()].filter((p) => p.order_id === decodeURIComponent(m![1])) });
    if (method === "GET" && path === "/orders") {
      const receipt = u.searchParams.get("receipt");
      return this.json({ items: [...this.orders.values()].filter((o) => o.receipt === receipt) });
    }
    throw new Error(`Unhandled fake Razorpay route: ${method} ${path}`);
  }
}
