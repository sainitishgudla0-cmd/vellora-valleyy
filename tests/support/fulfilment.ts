/** Test-only fixtures for GST, invoices, shipping and notifications (M7). Never imported by application code. */
import { vi } from "vitest";
import { db } from "@/lib/db";
import { createOrder } from "@/lib/orders";
import { mockMailbox } from "@/lib/notify/provider";
import { gstinCheckChar } from "@/lib/wholesale/gstin";

export const SELLER_BODY = "37AAAAA0000A1Z";
export const SELLER_GSTIN = SELLER_BODY + gstinCheckChar(SELLER_BODY);
export const SHIP_TO_AP = { customerName: "SMOKE TEST Stock", email: "smoke.m7@m5-fixture.example.com", phone: "9876543210", addressLine1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh" as const, pincode: "515001" };
export const SHIP_TO_KA = { ...SHIP_TO_AP, city: "Bengaluru", state: "Karnataka" as const, pincode: "560001" };

export function fulfilmentEnv() {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("PAYMENT_MODE", "request_only");
  vi.stubEnv("SELLER_GSTIN", SELLER_GSTIN);
  vi.stubEnv("NOTIFY_MODE", "");
}

export const notifyOn = () => vi.stubEnv("NOTIFY_MODE", "mock");

export async function setRate(code: string, rateBp: number, from = "2020-01-01", note?: string) {
  return db.taxRate.upsert({ where: { code_effectiveFrom: { code, effectiveFrom: new Date(`${from}T00:00:00.000Z`) } }, create: { code, rateBp, effectiveFrom: new Date(`${from}T00:00:00.000Z`), note }, update: { rateBp } });
}

export type ShipTo = typeof SHIP_TO_AP | typeof SHIP_TO_KA;
export async function placeCod(variantId: string, over: { ship?: ShipTo; quantity?: number; email?: string } = {}) {
  return createOrder({ ...(over.ship ?? SHIP_TO_AP), ...(over.email ? { email: over.email } : {}), paymentMethod: "cod", items: [{ variantId, quantity: over.quantity ?? 2 }] });
}

export async function cleanupFulfilmentFixtures() {
  await db.invoice.deleteMany({});
  await db.invoiceSeries.deleteMany({});
  await db.shippingRule.deleteMany({});
  await db.taxRate.deleteMany({});
  await db.outboxMessage.deleteMany({});
  mockMailbox.length = 0;
}
