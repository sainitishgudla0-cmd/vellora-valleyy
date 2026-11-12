import type { BusinessAccount } from "@prisma/client";

/** Staff view of a business account (includes the internal note). Route files cannot export helpers, so it lives here. */
export const accountAdminView = (a: BusinessAccount) => ({
  id: a.id,
  status: a.status,
  companyName: a.companyName,
  gstin: a.gstin,
  contactName: a.contactName,
  contactEmail: a.contactEmail,
  phone: a.phone,
  interest: a.interest,
  message: a.message,
  linkedToCustomer: a.customerId !== null,
  priceListId: a.priceListId,
  paymentTerms: a.paymentTerms,
  creditLimit: a.creditLimit,
  adminNote: a.adminNote,
  approvedAt: a.approvedAt,
  createdAt: a.createdAt,
});
