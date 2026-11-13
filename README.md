# Velora Valley — e-commerce website

Premium dry fruits, nuts, dates and seeds from **Velora Valley** by **Anantha Food Products**, Anantapur.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS · GSAP + ScrollTrigger + SplitText · Framer Motion · Lenis · Prisma (Postgres) · Zustand · Zod

## Live site
**https://velora-valley.vercel.app**, hosted on Vercel (project `velora-valley`, team *Sai nitish's projects*, region Singapore). The database is Neon Postgres, connected through the Vercel integration.

## Local development
Engineering docs start at [`CLAUDE.md`](CLAUDE.md) (commands, safety rules) and [`docs/`](docs/).
```bash
nvm use                     # Node 24 (.nvmrc)
npm ci
cp .env.example .env        # point DATABASE_URL(_UNPOOLED) at a LOCAL or throwaway Postgres, never production
npm run db:setup            # guarded: prisma migrate deploy + catalogue seed (refuses non-disposable databases)
npm run dev                 # http://localhost:3000
npm run verify              # typecheck + unit tests + env gate
```
The production Neon credentials are marked *Sensitive* in Vercel and cannot be pulled locally, which is intentional.

## Where things live

| Area | Path |
| --- | --- |
| Brand, contact details, delivery fee, testimonials | `src/config/site.ts` |
| Product catalogue (brochure data: MRP, barcode, shelf life, HS code) | `src/data/products.ts` |
| Categories | `src/data/categories.ts` |
| Five-stage quality process copy | `src/data/process.ts` |
| Database schema | `prisma/schema.prisma` |
| Catalogue queries | `src/lib/catalog.ts` |
| Orders, payments, validation, admin auth | `src/lib/*.ts` |
| API routes | `src/app/api/**` |
| Pages | `src/app/**/page.tsx` |
| Design system (frames, stamps, badges, buttons) | `src/components/ui`, `src/styles/globals.css`, `tailwind.config.ts` |
| Scroll animation system | `src/components/motion` |
| Asset pipeline (brochure, photos → `public/images`) | `scripts/prepare-assets.py` |

### Editing products and prices
- **Prices and stock:** sign in at `/admin` (Products tab). Changes apply immediately to the shop and to new orders.
- **New products:** add an entry to `src/data/products.ts` and images in `public/images/products/<slug>/`, then run `npm run db:seed` locally. Deploys no longer seed production automatically; syncing the catalogue to production is an explicit, confirmed operator step (see [`docs/RUNBOOK-DATABASE.md`](docs/RUNBOOK-DATABASE.md)). Seeding never overwrites prices edited in the admin; `--reset-prices` restores brochure MRPs.
- Prices start at the brochure MRPs, which are reference data. Check them before launch.

### Testimonials
The brochure contains no customer reviews, so the testimonial section shows a placeholder that invites feedback. Add real, approved quotes to `testimonials` in `src/config/site.ts` and they replace the placeholder automatically.

## Orders and payments
- **Order request, payment pending (default):** the order is saved as *awaiting confirmation*. The customer is told no payment has been taken and that the team will call to confirm. Manage these in `/admin`.
- **Payment mode** is set by `PAYMENT_MODE` (`mock` | `request_only` | `razorpay_test` | `razorpay_live`) and validated against the environment; unsafe combinations fail the build (`npm run env:check`) and disable online payment at runtime. Unset means `request_only`. Contract: [`docs/DECISIONS/0002-environment-and-payment-modes.md`](docs/DECISIONS/0002-environment-and-payment-modes.md).
- **Online payment (Razorpay):** offered only in `razorpay_test` / `razorpay_live` with matching keys. Orders are marked paid only after the Razorpay signature has been verified on the server, and only from *awaiting payment*.
- Totals are always recalculated on the server from database prices. Client-side prices are for display only.
- The delivery fee is `site.delivery.fee` (default 0, with a note that charges are confirmed before dispatch).
- Order confirmation pages are private. They need the access token included in the link the customer receives.

## Admin
`/admin` is protected by `ADMIN_PASSWORD` and an HMAC-signed, httpOnly session cookie (`SESSION_SECRET`, at least 24 characters). It covers orders (status updates), enquiries (contact and business), price and stock editing, and the newsletter subscriber count.

## Testing
See [`docs/TESTING.md`](docs/TESTING.md). In short:
```bash
npm run verify                                   # typecheck + unit tests + env gate (no database)
TEST_TARGET=disposable APP_ENV=test DATABASE_URL=... npm run verify:full   # migrate, integration, build, API smoke on a throwaway DB
```
Write-capable tests refuse to run unless the target server confirms its database is disposable; production hosts are always refused.

## Deploying (Vercel)
Production deploys are made with the Vercel CLI from a reviewed checkout of `main`. Do not deploy feature branches to production.
- `vercel.json` pins the Next.js preset, the build command (`npm run vercel-build`) and the region (`sin1`).
- `vercel-build` = `env:check` → `prisma generate` → `next build`. **It no longer changes the database.** Schema migrations and catalogue syncs are separate, explicit steps: [`docs/RUNBOOK-DATABASE.md`](docs/RUNBOOK-DATABASE.md). Production has not yet been baselined onto Prisma Migrate; follow the runbook before the first production migration.
- Production environment variables (set in Vercel, never in code):

| Variable | Set by | Notes |
| --- | --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (+ other `DATABASE_*`) | Neon integration | Sensitive |
| `SESSION_SECRET` | generated randomly at setup | Sensitive; signs admin sessions |
| `ADMIN_PASSWORD` | you (`vercel env add ADMIN_PASSWORD production --sensitive`) | Sensitive |
| `NEXT_PUBLIC_SITE_URL` | setup | `https://velora-valley.vercel.app`; change it if you add a custom domain |
| `PAYMENT_MODE` | you, optional | Defaults to `request_only` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_LIVE_ENABLED` | you, when launching (M10) | Only used with `razorpay_test` / `razorpay_live`; the webhook secret is required for live |

  Environment variable changes only take effect after a redeploy.
- The in-memory rate limiter works per serverless instance (shared store planned, see `docs/BACKEND-ROADMAP.md`).
- Check the social media URLs in `src/config/site.ts`. They are built from the brochure handle `@veloravalley`.
- Test data: the smoke and UI tests create records named "SMOKE TEST..." and only ever run against disposable databases. Any legacy test records in production can be removed with **Remove test data** in `/admin`.

## Content principles
All product facts come from the brochure. Ingredients, nutrition values, certifications, health claims, discounts and reviews have deliberately **not** been invented. Product pages direct customers to the pack label for ingredient, nutrition and allergen information.
