/**
 * Compatibility facade (M4): the dashboard page still imports these two names from here.
 * The implementation is in src/lib/auth/admin.ts (individual accounts, DB sessions, roles).
 */
export { adminConfigured, isAdmin } from "@/lib/auth/admin";
