# Architecture

State as of M11 (`backend/m11-stabilization`, 2026-11-20). Contracts: `API-CONTRACTS.md`. Decisions: `DECISIONS/` (ADRs 0001-0023). Operations: `RELEASE.md`, `RUNBOOK-DATABASE.md`. Tracker: `M11-RELEASE-READINESS.md`.

## Runtime
- **Next.js 16 App Router** on Vercel (`sin1`, Node 24, Fluid Compute). One deployable app: UI, route handlers and server components.
- **Postgres** (Neon in production) through **Prisma 5.22** (`src/lib/db.ts`, a singleton client). Pooled `DATABASE_URL` at runtime; `DATABASE_URL_UNPOOLED` for migrations. Schema changes only through `prisma/migrations` (14 migrations: `0_init` + M2-M10), all additive after the M2 enum cast (`tests/unit/migration-safety.test.ts`).
- **Rendering:** `layout.tsx` and catalogue pages read the DB with `revalidate = 60`, so **`next build` needs a reachable, migrated database (read-only)**; the build never writes (`tests/unit/vercel-config.test.ts`). Checkout, order, shop, account and admin pages are dynamic.
- **Scheduled jobs** (`vercel.json` crons, bearer `CRON_SECRET`): order expiry, payment reconciliation, notification outbox.
- **Client state:** cart in Zustand + localStorage (`src/store/cart.ts`), display only. The server recalculates everything.

## Module boundaries
| Layer | Location | Rule |
|---|---|---|
| Storefront UI (design frozen) | `src/app/**/page.tsx`, `src/components`, `src/styles`, `src/store` | Calls `/api/*` or `src/lib` read functions only; visual regression against the approved commit (`npm run test:visual-ref`) |
| Admin UI | `src/app/admin/**`, `src/components/admin/*` | Thin forms over the audited admin API; the server decides every permission and transition |
| Route handlers | `src/app/api/**/route.ts` | Thin: Zod parse → auth (`requireAdmin(req, permission)` / `requireCustomer` / `requireBusiness`) → lib call → `json`/`fail` |
| Domain logic | `src/lib/<domain>/` (`orders`, `payments`, `inventory`, `auth`, `account`, `wholesale`, `tax`, `invoices`, `shipping`, `notify`, `ops`) | Server-only, unit-testable; money in integer paise |
| Environment contracts | `src/lib/env/*` (`app-env`, `payment-config`, `notify-config`, `otp-config`, `smtp-config`, `security-config`, `isolation`, `test-safety`) | **Pure** (no `server-only`): shared by app, scripts, the build gate (`env:check`) and tests |
| Data | `prisma/schema.prisma`, `prisma/migrations/` | Migrations are the only path for schema change |
| Catalogue source | `src/data/products.ts` → `prisma/seed.ts` | Upsert; admin-edited prices preserved; run by an operator, never by a build |
| Ops scripts | `scripts/*` | Every write path is guarded (`scripts/db-guard.ts`); read-only reports (`ops:readiness`, `tax:signoff-sheet`) print no secrets |

## Key flows
- **Order:** `POST /api/orders` → `createOrder`: one transaction for prices from the DB, shipping rules, GST snapshot per line, stock holds (tracked variants), payment attempt, idempotency key, outbox message. Statuses change only through `transitionOrder` (state machine + `OrderEvent`).
- **Online payment (Razorpay, off by default):** checkout creates the gateway order; the browser's `/verify`, the signed webhook and reconciliation all end in `applyGatewayPayment` (conditional updates; captures that cannot be applied are kept as orphan captures for refund). Unpaid attempts expire after the payment window and release stock; failed attempts and late captures are covered by M11 P1-T3 (ADR 0020, integrated separately).
- **Refunds:** owner accounts only, through the `Refund` ledger (row lock, receipt = row id, gateway outcome reconciled). A refund request is audited in the same transaction as its ledger row.
- **Admin:** individual accounts with roles (owner, operations, catalog, viewer), DB sessions, permission per route, append-only audit log; critical successes (order/payment changes, refund requests, account/role/credential changes, owner recovery) are audited in-transaction and fail closed (ADR 0021). The shared `ADMIN_PASSWORD` login is read-only and always off in production (ADR 0022).
- **Customers:** emailed one-time codes (SMTP when configured, ADR 0023), sessions, addresses, order history, claims, export/erasure; wholesale buyers get price lists, MOQ, quotes and credit limits (`/api/business/*`).
- **Fulfilment:** shipments and tracking, GST invoices with gap-free numbering, transactional outbox for emails.
- **Rate limits:** shared Postgres counters per IP; sensitive buckets fail closed when the store fails (ADR 0022).
- **Readiness:** `GET /api/admin/readiness` / `npm run ops:readiness` summarise configuration still owed by the business or operator and money needing a person.

## Environments
| | `APP_ENV` | Database | Payment modes |
|---|---|---|---|
| Local dev | development | local Postgres / disposable Neon branch | mock, request_only, razorpay_test |
| Tests / CI | test | throwaway Postgres (CI service container) | mock, request_only, razorpay_test |
| Vercel preview | preview | **must not be production**: enforced at build by `env:check` via `PRODUCTION_DB_HOSTS` (ADR 0017); the Vercel scope itself is still to be verified by the operator (`RELEASE.md` A3) | request_only, razorpay_test |
| Vercel production | production | Neon production (not yet baselined; first cutover `RELEASE.md` B0) | request_only (now), razorpay_live (launch checklist, `RELEASE.md` E) |

## Integration strategy
Extend in place rather than rewrite: services under `src/lib/<domain>/`, additive migrations, backward-compatible response shapes for the storefront. Storefront design changes need the owner's approval (the visual regression check fails otherwise).
