import "server-only";
import { db } from "@/lib/db";
import { PRIVACY_NOTICE_VERSION } from "./consent";

export const profileSelect = { id: true, email: true, name: true, phone: true, marketingConsent: true, createdAt: true, lastLoginAt: true } as const;

export async function getProfile(customerId: string) {
  const [customer, consents] = await Promise.all([
    db.customer.findUnique({ where: { id: customerId }, select: profileSelect }),
    db.consentRecord.findMany({ where: { customerId }, orderBy: { createdAt: "asc" }, select: { purpose: true, granted: true, version: true, createdAt: true } }),
  ]);
  return customer ? { ...customer, consents } : null;
}

export async function updateProfile(customerId: string, patch: { name?: string | null; phone?: string | null }) {
  return db.customer.update({ where: { id: customerId }, data: { ...(patch.name !== undefined && { name: patch.name }), ...(patch.phone !== undefined && { phone: patch.phone }) }, select: profileSelect });
}

/** Marketing consent is opt-in and revocable; every change appends a consent record. Returns whether anything changed. */
export async function setMarketingConsent(customerId: string, granted: boolean): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const r = await tx.customer.updateMany({ where: { id: customerId, marketingConsent: !granted }, data: { marketingConsent: granted } });
    if (r.count !== 1) return false;
    await tx.consentRecord.create({ data: { customerId, purpose: "marketing", granted, version: PRIVACY_NOTICE_VERSION } });
    return true;
  });
}
