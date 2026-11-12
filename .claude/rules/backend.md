---
paths:
  - "src/app/api/**"
  - "src/lib/**"
---
# Backend rules

- Route handlers stay thin: parse with `parseBody(req, zodSchema)` → auth check → call a `src/lib` function → `json()` / `fail()` (`src/lib/api.ts`). Business rules live in `src/lib`, as pure functions where possible (see `src/lib/payment-verification.ts`).
- Server-only modules import `"server-only"`. Modules that scripts or the build also need (`src/lib/env/*`) must stay pure.
- Money is integer paise. Never trust client prices, totals or statuses; recompute from the database.
- State changes that depend on current state use a conditional write (`updateMany` with the expected state in `where`, or a transaction) and handle `count === 0`.
- Admin routes call `requireAdmin(req, permission)` first (401/403) and `writeAudit` on every mutation. Public write routes are rate-limited (`src/lib/rate-limit.ts`).
- Errors: 400 bad input · 401/403 auth · 404 unknown or not yours · 409 state conflict · 422 validation · 429 rate limit · 503 misconfigured dependency. Never leak stack traces, secrets or other customers' data.
- Any contract change updates `docs/API-CONTRACTS.md` in the same commit.
- Stock counters (`Variant.stockQuantity`/`reserved`/`trackInventory`) change only through `src/lib/inventory` (ledger); never `variant.update` them directly (ratchet test).
