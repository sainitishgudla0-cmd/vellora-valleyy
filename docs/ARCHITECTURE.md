# Architecture

State as of M1 (`backend/m1-foundation`). Contracts: `API-CONTRACTS.md`. Plans: `BACKEND-ROADMAP.md`.

## Runtime
- **Next.js 16 App Router** on Vercel (`sin1`, Node 24, Fluid Compute). One deployable app: UI, route handlers and server components.
- **Postgres** (Neon in production, via the Vercel integration) through **Prisma 5.22** (`src/lib/db.ts`, a singleton client). Pooled `DATABASE_URL` at runtime; `DATABASE_URL_UNPOOLED` for migrations.
- **Rendering:** `layout.tsx` and catalogue pages read the DB with `revalidate = 60`, so **`next build` needs a reachable database (read-only)**. Checkout, order, shop and admin pages are dynamic.
- **Client state:** cart in Zustand + localStorage (`src/store/cart.ts`), display only. The server recalculates everything.

## Module boundaries
| Layer | Location | Rule |
|---|---|---|
| UI (frozen) | `src/app/**/page.tsx`, `src/components`, `src/styles`, `src/store` | Calls `/api/*` or `src/lib` read functions only |
| Route handlers | `src/app/api/**/route.ts` | Thin: Zod parse → auth → lib call → `json`/`fail` |
| Domain logic | `src/lib/*.ts` (`orders`, `catalog`, `payments`, `payment-verification`, `admin-auth`, `validation`) | Server-only, unit-testable, pure decisions where possible |
| Environment contracts | `src/lib/env/*` (`app-env`, `payment-config`, `test-safety`) | **Pure** (no `server-only`): shared by app, scripts, build gate and tests |
| Data | `prisma/schema.prisma`, `prisma/migrations/` | Migrations are the only path for schema change |
| Catalogue source | `src/data/products.ts` → `prisma/seed.ts` | Upsert; admin-edited prices preserved |
| Ops scripts | `scripts/*` | Every write path is guarded (`scripts/db-guard.ts`, `scripts/lib/safety.ts`) |

## Key flows
- **Order (request / COD):** `POST /api/orders` → `createOrder` (DB prices, merged lines) → `pending_confirmation` / `unpaid` → staff confirm in `/admin`.
- **Order (Razorpay, disabled by default):** `createOrder` (`awaiting_payment`) → Razorpay order → browser Checkout.js → `POST /api/payments/razorpay/verify` → `decideVerification` → conditional `updateMany` to `paid`. No webhook yet (M10), so a closed tab can leave a paid order `awaiting_payment`.
- **Payment mode:** `resolvePaymentConfig()` maps `PAYMENT_MODE` + resolved `APP_ENV` to allowed behaviour. Invalid config fails the build (`env:check`) and disables online payment at runtime.
- **Admin:** single shared password → HMAC cookie (8 h, stateless). Orders, enquiries, prices and stock (M4 replaces this).

## Environments
| | `APP_ENV` | Database | Payment modes |
|---|---|---|---|
| Local dev | development | local Postgres / disposable Neon branch | mock, request_only, razorpay_test |
| Tests / CI | test | throwaway Postgres (CI service container) | mock, request_only, razorpay_test |
| Vercel preview | preview | **must not be production** (unverified, see PROGRESS blockers) | request_only, razorpay_test |
| Vercel production | production | Neon production | request_only (now), razorpay_live (M10) |

## Integration strategy (M2+)
Extend in place rather than rewrite:
- Add services under `src/lib/<domain>/` (e.g. `src/lib/orders/state-machine.ts`, `src/lib/payments/providers/*`) and keep existing exports as thin wrappers until callers move.
- New tables come in through additive migrations. Statuses move to Prisma enums with a backfill migration.
- Keep the frontend's data shapes (`ProductView`, order API responses) backward-compatible.
- New UI needs (accounts, wholesale) are integration tasks in M8 and need the user's approval.
