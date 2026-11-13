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
- Wholesale (`/api/business/*`) calls `requireBusiness(req)`; wholesale prices, MOQ and price lists never appear in retail routes or `src/lib/catalog.ts` (ratchet test); account and quote ids come from the session, and another account's data is a 404.
- Notifications go through the outbox (`enqueueOutbox` inside the changing transaction, `processOutbox` renders from the database); the only provider is a mock with no network code, `NOTIFY_MODE=mock` is refused in preview/production, and outbox rows never hold recipients, tokens or content. Invoices are frozen payloads rendered by a pure function; never edit or delete an `Invoice` row.
- Logging goes through `src/lib/log.ts` only (`log.error("area.event", { order, reason })`); never `console.*` (ratchet test), never error objects or messages (`errorName(e)` only), never tokens or personal data in fields. Public write routes use `rateLimit()` (Postgres-backed, shared across instances); don't add per-instance counters. New third-party origins need a CSP change in `config/security-headers.mjs` plus a test. `docs/RELEASE.md` lists what only the operator may change (production baselining, Vercel and GitHub settings).
- Machine-to-machine endpoints (the Razorpay webhook, `/api/internal/*` cron routes) authenticate by HMAC of the raw body or a bearer secret compared in constant time, before parsing or any database access; they log event names and outcome codes only, never payloads or signatures. `RAZORPAY_WEBHOOK_SECRET` is a separate secret from the API key secret.
