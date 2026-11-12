/** Test-only wholesale fixtures. Real customers, real accounts and real sessions; never imported by application code. */
import type { BusinessAccountStatus, PaymentTerms } from "@prisma/client";
import { db } from "@/lib/db";
import { gstinCheckChar } from "@/lib/wholesale/gstin";
import { freshEmail, signInCustomer } from "./customer";

let seq = 0;
const tag = Date.now();

/** A well-formed GSTIN (valid format and check character), unique per call. */
export function makeGstin(): string {
  const n = ++seq + tag;
  const letters = (k: number) => Array.from({ length: 5 }, (_, i) => String.fromCharCode(65 + (Math.floor(k / 26 ** i) % 26))).join("");
  const body = `29${letters(n)}${String(n % 10000).padStart(4, "0")}${String.fromCharCode(65 + (n % 26))}1Z`;
  return body + gstinCheckChar(body);
}

export async function createPriceList(name: string, entries: { variantId: string; tiers: { minQty: number; unitPrice: number }[] }[] = [], active = true) {
  const list = await db.priceList.create({ data: { name: `m6-${tag}-${++seq}-${name}`, active } });
  for (const e of entries) await db.priceListItem.createMany({ data: e.tiers.map((t) => ({ priceListId: list.id, variantId: e.variantId, ...t })) });
  return list;
}

export async function setTerms(variantId: string, moq: number, casePack: number) {
  await db.variantWholesale.upsert({ where: { variantId }, create: { variantId, moq, casePack }, update: { moq, casePack } });
}

/** A signed-in customer with a business account in the given state. */
export async function makeBuyer(over: { status?: BusinessAccountStatus; paymentTerms?: PaymentTerms; creditLimit?: number; priceListId?: string | null; email?: string } = {}) {
  const c = await signInCustomer(over.email ?? freshEmail("buyer"));
  const account = await db.businessAccount.create({
    data: {
      customerId: c.customerId,
      contactEmail: c.email,
      companyName: "Rao Traders",
      gstin: makeGstin(),
      contactName: "Asha Rao",
      phone: "9876543210",
      status: over.status ?? "approved",
      approvedAt: (over.status ?? "approved") === "approved" ? new Date() : null,
      paymentTerms: over.paymentTerms ?? "prepaid",
      creditLimit: over.creditLimit ?? 0,
      priceListId: over.priceListId ?? null,
    },
  });
  return { ...c, account };
}

export const SHIPPING = { customerName: "Asha Rao", email: "orders@rao-traders.example.com", phone: "9876543210", addressLine1: "12 Market Yard Road", city: "Anantapur", state: "Andhra Pradesh" as const, pincode: "515001" };

export async function cleanupWholesaleFixtures() {
  const accounts = await db.businessAccount.findMany({ where: { OR: [{ contactEmail: { endsWith: "@m5-fixture.example.com" } }, { companyName: "Rao Traders" }, { contactEmail: "erased@erased.invalid" }, { contactEmail: { endsWith: "@m6-fixture.example.com" } }] }, select: { id: true } });
  const ids = accounts.map((a) => a.id);
  await db.order.deleteMany({ where: { businessAccountId: { in: ids } } });
  await db.quote.deleteMany({ where: { businessAccountId: { in: ids } } });
  await db.businessAccount.deleteMany({ where: { id: { in: ids } } });
  await db.priceList.deleteMany({ where: { name: { startsWith: "m6-" } } });
}
