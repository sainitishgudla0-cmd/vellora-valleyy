import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const MAX_ADDRESSES = 10;
export interface AddressInput {
  label?: string | null;
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault?: boolean;
}
export type AddressResult<T = object> = ({ ok: true } & T) | { ok: false; code: "not_found" | "limit_reached"; message: string };

const select = { id: true, label: true, name: true, phone: true, line1: true, line2: true, city: true, state: true, pincode: true, isDefault: true, createdAt: true } as const;

export const listAddresses = (customerId: string) => db.address.findMany({ where: { customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select });

/** The customer row is locked for the transaction, so concurrent writes cannot break the limit or the single-default rule. */
const lock = (tx: Prisma.TransactionClient, customerId: string) => tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;

export async function createAddress(customerId: string, input: AddressInput): Promise<AddressResult<{ address: Awaited<ReturnType<typeof listAddresses>>[number] }>> {
  return db.$transaction(async (tx) => {
    await lock(tx, customerId);
    const count = await tx.address.count({ where: { customerId } });
    if (count >= MAX_ADDRESSES) return { ok: false as const, code: "limit_reached" as const, message: `You can save up to ${MAX_ADDRESSES} addresses` };
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault) await tx.address.updateMany({ where: { customerId, isDefault: true }, data: { isDefault: false } });
    const { isDefault: _ignored, ...rest } = input;
    const address = await tx.address.create({ data: { ...rest, customerId, isDefault: makeDefault }, select });
    return { ok: true as const, address };
  });
}

export async function updateAddress(customerId: string, id: string, patch: Partial<AddressInput>): Promise<AddressResult<{ address: Awaited<ReturnType<typeof listAddresses>>[number] }>> {
  return db.$transaction(async (tx) => {
    await lock(tx, customerId);
    const current = await tx.address.findFirst({ where: { id, customerId }, select: { id: true, isDefault: true } }); // another customer's id is simply "not found"
    if (!current) return { ok: false as const, code: "not_found" as const, message: "Address not found" };
    const { isDefault, ...rest } = patch;
    if (isDefault === true) await tx.address.updateMany({ where: { customerId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
    // the only default cannot be un-defaulted directly: make another address the default instead
    const address = await tx.address.update({ where: { id }, data: { ...rest, ...(isDefault === true ? { isDefault: true } : {}) }, select });
    return { ok: true as const, address };
  });
}

export async function deleteAddress(customerId: string, id: string): Promise<AddressResult> {
  return db.$transaction(async (tx) => {
    await lock(tx, customerId);
    const gone = await tx.address.deleteMany({ where: { id, customerId } });
    if (gone.count !== 1) return { ok: false as const, code: "not_found" as const, message: "Address not found" };
    const hasDefault = await tx.address.count({ where: { customerId, isDefault: true } });
    if (!hasDefault) {
      const next = await tx.address.findFirst({ where: { customerId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { ok: true as const };
  });
}
