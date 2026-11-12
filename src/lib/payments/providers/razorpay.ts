import crypto from "node:crypto";
import type { PaymentConfig } from "@/lib/env/payment-config";
import { ProviderUnavailableError, type PaymentProvider } from "./types";

/**
 * Razorpay adapter: Orders/Payments REST calls plus the checkout-signature check.
 * Every network call has a timeout and failures are classified (`GatewayError.kind`) so callers can tell a
 * definite rejection (nothing was created) from an unknown outcome (timeout, 5xx, lost response).
 * Tests replace `fetch` with deterministic fakes; nothing here is ever pointed at live services by tests.
 */
export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
}

export type GatewayErrorKind =
  /** The gateway refused the request (4xx): nothing was created. */
  | "rejected"
  /** Timeout, network failure, 429 or 5xx: the outcome is unknown. */
  | "unavailable"
  /** The gateway answered but the body was unusable or disagreed with what we asked for. */
  | "invalid_response"
  /** 404 on a lookup. */
  | "not_found";

export class GatewayError extends Error {
  constructor(public kind: GatewayErrorKind, message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string | null;
  status?: string;
}

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  status: string;
  amount: number;
  currency: string;
}

export interface RazorpayGateway {
  createOrder(amountPaise: number, receipt: string): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  findOrdersByReceipt(receipt: string): Promise<GatewayOrder[]>;
}

const BASE = "https://api.razorpay.com/v1";
export const GATEWAY_TIMEOUT_MS = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseOrder(v: unknown): GatewayOrder {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.amount !== "number" || typeof v.currency !== "string") throw new GatewayError("invalid_response", "Unexpected gateway order response");
  return { id: v.id, amount: v.amount, currency: v.currency, receipt: typeof v.receipt === "string" ? v.receipt : null, status: typeof v.status === "string" ? v.status : undefined };
}

function parsePayment(v: unknown): GatewayPayment {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.status !== "string" || typeof v.amount !== "number" || typeof v.currency !== "string") {
    throw new GatewayError("invalid_response", "Unexpected gateway payment response");
  }
  return { id: v.id, orderId: typeof v.order_id === "string" ? v.order_id : null, status: v.status, amount: v.amount, currency: v.currency };
}

export function createRazorpayGateway(keys: RazorpayKeys): RazorpayGateway {
  const auth = "Basic " + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError("unavailable", "Gateway request failed or timed out"); // never include the error: it may echo headers/URLs
    }
    if (res.status === 404) throw new GatewayError("not_found", "Gateway resource not found");
    if (res.status === 429 || res.status >= 500) throw new GatewayError("unavailable", `Gateway unavailable (${res.status})`);
    if (!res.ok) throw new GatewayError("rejected", `Gateway rejected the request (${res.status})`);
    try {
      return await res.json();
    } catch {
      throw new GatewayError("invalid_response", "Gateway returned a non-JSON body");
    }
  }

  return {
    async createOrder(amountPaise, receipt) {
      return parseOrder(await call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt }));
    },
    async fetchPayment(paymentId) {
      return parsePayment(await call("GET", `/payments/${encodeURIComponent(paymentId)}`));
    },
    async listOrderPayments(orderId) {
      const r = await call("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
      if (!isObj(r) || !Array.isArray(r.items)) throw new GatewayError("invalid_response", "Unexpected gateway payments list");
      return r.items.map(parsePayment);
    },
    async findOrdersByReceipt(receipt) {
      const r = await call("GET", `/orders?receipt=${encodeURIComponent(receipt)}&count=10`);
      if (!isObj(r) || !Array.isArray(r.items)) throw new GatewayError("invalid_response", "Unexpected gateway orders list");
      return r.items.map(parseOrder);
    },
  };
}

export function verifyRazorpaySignatureWith(keySecret: string, orderId: string, paymentId: string, signature: string) {
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Back-compat helper used by the payments.ts facade. */
export async function createRazorpayOrder(keys: RazorpayKeys, amountPaise: number, receipt: string) {
  const o = await createRazorpayGateway(keys).createOrder(amountPaise, receipt);
  return { id: o.id, amount: o.amount, currency: o.currency };
}

export type RazorpayProvider = PaymentProvider & { gateway: RazorpayGateway };

export function createRazorpayProvider(config: Pick<PaymentConfig, "mode" | "razorpay">): RazorpayProvider {
  if ((config.mode !== "razorpay_test" && config.mode !== "razorpay_live") || !config.razorpay) {
    throw new ProviderUnavailableError("The Razorpay provider requires a valid razorpay_test or razorpay_live configuration.");
  }
  const keys = config.razorpay;
  const gateway = createRazorpayGateway(keys);
  return {
    id: "razorpay",
    mode: config.mode,
    online: true,
    label: null,
    gateway,
    async createPayment(req) {
      const rp = await gateway.createOrder(req.amountPaise, req.orderNumber);
      // the gateway must echo exactly what we asked for; anything else is unusable
      if (rp.amount !== req.amountPaise || rp.currency !== req.currency || !rp.id) throw new GatewayError("invalid_response", "Gateway order does not match the requested amount or currency");
      return {
        providerOrderId: rp.id,
        amountPaise: rp.amount,
        currency: rp.currency,
        clientPayload: { provider: "razorpay", keyId: keys.keyId, orderId: rp.id, amount: rp.amount, currency: rp.currency },
      };
    },
    verifyPayment: (p) => verifyRazorpaySignatureWith(keys.keySecret, p.providerOrderId, p.providerPaymentId, p.signature),
  };
}
