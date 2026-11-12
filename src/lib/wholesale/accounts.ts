import "server-only";
import { Prisma, type BusinessAccount, type BusinessAccountStatus, type PaymentTerms } from "@prisma/client";
import { db } from "@/lib/db";
import { validateGstin } from "./gstin";

/**
 * Business accounts (M6, ADR 0014): application, approval workflow, linking to a verified customer.
 * A buyer is a signed-in customer (M5, email-verified) with an APPROVED account. Retail routes never look at accounts.
 */
export const LIVE_STATUSES: BusinessAccountStatus[] = ["pending", "approved", "suspended"];

/** Status graph. `closed` is terminal; `rejected` can still be approved later by staff. */
export const ACCOUNT_TRANSITIONS: Readonly<Record<BusinessAccountStatus, readonly BusinessAccountStatus[]>> = {
  pending: ["approved", "rejected", "closed"],
  approved: ["suspended", "closed"],
  suspended: ["approved", "closed"],
  rejected: ["approved"],
  closed: [],
};

export type AccountErrorCode = "not_found" | "already_applied" | "gstin_in_use" | "invalid_gstin" | "invalid_transition" | "stale_state" | "price_list_not_found" | "credit_limit_required" | "account_exists" | "not_a_business_enquiry";
export type AccountResult<T = object> = ({ ok: true } & T) | { ok: false; code: AccountErrorCode; message: string };
const fail = (code: AccountErrorCode, message: string): { ok: false; code: AccountErrorCode; message: string } => ({ ok: false, code, message });

const isUnique = (e: unknown, col: string) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes(col);

/**
 * The account of a signed-in customer. An account created by staff from an enquiry carries only a contact email; the
 * verified owner of that address is linked to it here, on first use (a customer holds at most one account).
 */
export async function findAccountForCustomer(customer: { customerId: string; email: string }): Promise<BusinessAccount | null> {
  const own = await db.businessAccount.findUnique({ where: { customerId: customer.customerId } });
  if (own) return own;
  const pending = await db.businessAccount.findFirst({ where: { customerId: null, contactEmail: customer.email.toLowerCase() }, orderBy: { createdAt: "desc" } });
  if (!pending) return null;
  try {
    const r = await db.businessAccount.updateMany({ where: { id: pending.id, customerId: null }, data: { customerId: customer.customerId } });
    if (r.count === 1) return { ...pending, customerId: customer.customerId };
  } catch (e) {
    if (!isUnique(e, "customerId")) throw e;
  }
  return db.businessAccount.findUnique({ where: { customerId: customer.customerId } });
}

export interface ApplyInput {
  companyName: string;
  gstin: string;
  contactName: string;
  phone: string;
  interest?: string | null;
  message?: string | null;
}

export async function applyForBusinessAccount(customer: { customerId: string; email: string }, input: ApplyInput): Promise<AccountResult<{ account: BusinessAccount }>> {
  const g = validateGstin(input.gstin);
  if (!g.ok) return fail("invalid_gstin", g.error);
  const existing = await findAccountForCustomer(customer);
  const data = { companyName: input.companyName, gstin: g.gstin, contactName: input.contactName, phone: input.phone, interest: input.interest ?? null, message: input.message ?? null };
  try {
    if (existing) {
      if (existing.status !== "rejected") return fail("already_applied", existing.status === "closed" ? "This account has been closed. Please contact us." : "You already have a business account application");
      // a rejected applicant may correct the details and apply again
      const r = await db.businessAccount.updateMany({ where: { id: existing.id, status: "rejected" }, data: { ...data, status: "pending", adminNote: null } });
      if (r.count !== 1) return fail("stale_state", "Your application changed; please refresh");
      return { ok: true, account: await db.businessAccount.findUniqueOrThrow({ where: { id: existing.id } }) };
    }
    const account = await db.businessAccount.create({ data: { ...data, customerId: customer.customerId, contactEmail: customer.email.toLowerCase() } });
    return { ok: true, account };
  } catch (e) {
    if (isUnique(e, "gstin") || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && !isUnique(e, "customerId"))) return fail("gstin_in_use", "A business account with this GSTIN already exists");
    if (isUnique(e, "customerId")) return fail("already_applied", "You already have a business account application");
    throw e;
  }
}

export interface AccountPatch {
  status?: BusinessAccountStatus;
  priceListId?: string | null;
  paymentTerms?: PaymentTerms;
  creditLimit?: number;
  adminNote?: string | null;
}

/** Staff change to an account. Status moves follow the graph; approving needs consistent terms; closing cancels open quotes. */
export async function updateAccountAsAdmin(id: string, patch: AccountPatch, adminId: string): Promise<AccountResult<{ account: BusinessAccount }>> {
  return db.$transaction(async (tx) => {
      const current = await tx.businessAccount.findUnique({ where: { id } });
      if (!current) return fail("not_found", "Account not found");
      const next = patch.status ?? current.status;
      if (patch.status && patch.status !== current.status && !ACCOUNT_TRANSITIONS[current.status].includes(patch.status)) return fail("invalid_transition", `An account cannot move from ${current.status} to ${patch.status}`);
      const terms = patch.paymentTerms ?? current.paymentTerms;
      const limit = patch.creditLimit ?? current.creditLimit;
      if ((next === "approved") && terms === "credit" && limit <= 0) return fail("credit_limit_required", "Credit terms need a credit limit greater than zero");
      if (patch.priceListId) {
        const list = await tx.priceList.findFirst({ where: { id: patch.priceListId, active: true }, select: { id: true } });
        if (!list) return fail("price_list_not_found", "Price list not found or not active");
      }
      const data: Prisma.BusinessAccountUpdateManyMutationInput & { priceListId?: string | null } = {
        ...(patch.status && patch.status !== current.status && { status: patch.status }),
        ...(patch.paymentTerms !== undefined && { paymentTerms: patch.paymentTerms }),
        ...(patch.creditLimit !== undefined && { creditLimit: patch.creditLimit }),
        ...(patch.adminNote !== undefined && { adminNote: patch.adminNote }),
        ...(patch.priceListId !== undefined && { priceListId: patch.priceListId }),
        ...(patch.status === "approved" && !current.approvedAt && { approvedAt: new Date() }),
      };
      const r = await tx.businessAccount.updateMany({ where: { id, status: current.status }, data });
      if (r.count !== 1) return fail("stale_state", "The account changed while you were editing it");
      if (patch.status === "closed") {
        // a closed account cannot buy: its open quotes are withdrawn in the same transaction
        const open = await tx.quote.findMany({ where: { businessAccountId: id, status: { in: ["requested", "quoted"] } }, select: { id: true, status: true } });
        for (const q of open) {
          const c = await tx.quote.updateMany({ where: { id: q.id, status: q.status }, data: { status: "cancelled", decidedAt: new Date() } });
          if (c.count === 1) await tx.quoteEvent.create({ data: { quoteId: q.id, fromStatus: q.status, toStatus: "cancelled", actorType: "admin", actorId: adminId } });
        }
      }
      return { ok: true as const, account: await tx.businessAccount.findUniqueOrThrow({ where: { id } }) };
  });
}

/** M6-T6: turn a business enquiry into an account (pending, or approved at once). The enquirer is linked when they sign in with that email. */
export async function convertEnquiry(
  enquiryId: string,
  input: { companyName: string; gstin: string; approve?: boolean; priceListId?: string | null; paymentTerms?: PaymentTerms; creditLimit?: number },
): Promise<AccountResult<{ account: BusinessAccount }>> {
  const g = validateGstin(input.gstin);
  if (!g.ok) return fail("invalid_gstin", g.error);
  const approve = input.approve === true;
  const terms = input.paymentTerms ?? "prepaid";
  if (approve && terms === "credit" && (input.creditLimit ?? 0) <= 0) return fail("credit_limit_required", "Credit terms need a credit limit greater than zero");
  try {
    return await db.$transaction(async (tx) => {
      const enquiry = await tx.enquiry.findUnique({ where: { id: enquiryId } });
      if (!enquiry) return fail("not_found", "Enquiry not found");
      if (enquiry.type !== "business") return fail("not_a_business_enquiry", "Only business enquiries can be converted");
      const email = enquiry.email.trim().toLowerCase();
      const customer = await tx.customer.findUnique({ where: { email }, select: { id: true } });
      const dup = await tx.businessAccount.findFirst({ where: { OR: [{ contactEmail: email }, ...(customer ? [{ customerId: customer.id }] : [])], status: { in: [...LIVE_STATUSES, "rejected" as const] } }, select: { id: true } });
      if (dup) return fail("account_exists", "This person already has a business account");
      if (input.priceListId && !(await tx.priceList.findFirst({ where: { id: input.priceListId, active: true }, select: { id: true } }))) return fail("price_list_not_found", "Price list not found or not active");
      const account = await tx.businessAccount.create({
        data: {
          customerId: customer?.id ?? null,
          contactEmail: email,
          companyName: input.companyName,
          gstin: g.gstin,
          contactName: enquiry.name,
          phone: enquiry.phone ?? "",
          interest: enquiry.interest,
          message: enquiry.message.slice(0, 2000),
          status: approve ? "approved" : "pending",
          approvedAt: approve ? new Date() : null,
          priceListId: input.priceListId ?? null,
          paymentTerms: terms,
          creditLimit: input.creditLimit ?? 0,
        },
      });
      await tx.enquiry.update({ where: { id: enquiryId }, data: { status: approve ? "closed" : "in_progress" } });
      return { ok: true as const, account };
    });
  } catch (e) {
    if (isUnique(e, "gstin")) return fail("gstin_in_use", "A business account with this GSTIN already exists");
    throw e;
  }
}

/** Credit exposure: what the account still owes on orders that are not cancelled and not paid. */
export async function outstandingAmount(tx: Prisma.TransactionClient, accountId: string): Promise<number> {
  const r = await tx.order.aggregate({ where: { businessAccountId: accountId, status: { not: "cancelled" }, paymentStatus: { not: "paid" } }, _sum: { total: true } });
  return r._sum.total ?? 0;
}
