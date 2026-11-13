/**
 * Admin roles and permissions (M4, ADR 0012). Pure: no I/O, importable anywhere.
 * Routes ask for a permission, never for a role name, so the matrix below is the single place that decides access.
 */
export const ADMIN_ROLES = ["owner", "operations", "catalog", "viewer"] as const;
export type AdminRoleName = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  "admin:read", // open the dashboard, read stock lists, see your own account and sessions
  "orders:write", // order status and payment changes
  "enquiries:write",
  "variants:write", // reach the variant endpoint at all (fields are then checked individually)
  "catalog:write", // price and manual availability flag
  "inventory:write", // track inventory and adjust stock
  "testdata:write", // remove SMOKE TEST records
  "users:manage", // accounts, roles, other people's sessions, audit log
  "wholesale:read", // business accounts, price lists, quotes (commercially sensitive)
  "wholesale:write", // approve accounts, convert enquiries, price quotes
  "pricing:write", // price lists and MOQ / case packs
  "fulfilment:read", // invoices, shipments, shipping rules, tax rates, notification outbox
  "fulfilment:write", // issue invoices, create/update shipments, shipping rules, retry notifications
  "tax:write", // GST rates (set with the accountant's sign-off)
  "refunds:write", // return money to a customer through the payment gateway (owner only: it moves real money)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<AdminRoleName, readonly Permission[]>> = {
  owner: PERMISSIONS,
  operations: ["admin:read", "orders:write", "enquiries:write", "variants:write", "inventory:write", "wholesale:read", "wholesale:write", "fulfilment:read", "fulfilment:write"],
  catalog: ["admin:read", "variants:write", "catalog:write", "inventory:write", "wholesale:read", "pricing:write"],
  viewer: ["admin:read"],
};

/** Permissions that only a real account may hold: the shared-password (legacy) session never gets them. */
const ACCOUNT_ONLY: readonly Permission[] = ["users:manage", "refunds:write"];

export function hasPermission(role: AdminRoleName, permission: Permission, legacy = false): boolean {
  if (legacy && ACCOUNT_ONLY.includes(permission)) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
