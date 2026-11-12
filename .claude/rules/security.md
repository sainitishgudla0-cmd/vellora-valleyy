---
paths:
  - "src/app/api/**"
  - "src/lib/**"
  - "src/app/admin/**"
  - "next.config.mjs"
  - "vercel.json"
---
# Security rules

- Validate every external input with Zod at the boundary; cap string lengths and array sizes.
- Compare secrets and tokens in constant time (`safeEqual` in `src/lib/payment-verification.ts`, `checkPassword`).
- Never put secrets, tokens or personal data in URLs you create, logs, error messages, test fixtures or docs. Use obviously fake test values.
- Admin and customer authorization is checked server-side on every request; never rely on the UI hiding a control. Admin routes call `requireAdmin(req, "<permission>")` (`src/lib/auth/admin.ts`) and every admin mutation calls `writeAudit` (ratchet test); never log or audit passwords, tokens, reasons or customer data.
- New dependencies: exact versions only, justified in the commit message and PROGRESS, and `npm audit --omit=dev` must stay clean.
- Environment checks fail closed: if the environment or target can't be identified, refuse.
- Customer routes (`/api/account/*`) call `requireCustomer(req)`; the customer id comes only from the session, ownership is part of the query (`where { id, customerId }`), schemas are strict, and nothing returns another customer's data (404 for both missing and not-yours).
