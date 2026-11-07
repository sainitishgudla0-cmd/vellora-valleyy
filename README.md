# Velora Valley — e-commerce website

Premium dry fruits, nuts, dates and seeds from **Velora Valley** by **Anantha Food Products**, Anantapur.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS · GSAP + ScrollTrigger + SplitText · Framer Motion · Lenis · Prisma (SQLite → Postgres) · Zustand · Zod

## Live site
**https://velora-valley.vercel.app**, hosted on Vercel (project `velora-valley`, team *Sai nitish's projects*, region Singapore). The database is Neon Postgres, connected through the Vercel integration.

## Local development
```bash
npm install                 # npm 11 may ask you to approve install scripts:
                            #   npm install-scripts approve @prisma/client @prisma/engines prisma esbuild sharp && npm rebuild
cp .env.example .env        # add a Postgres DATABASE_URL + DATABASE_URL_UNPOOLED (e.g. a Neon dev branch), ADMIN_PASSWORD, SESSION_SECRET
npm run db:setup            # create the tables and load the catalogue from the brochure data
npm run dev                 # http://localhost:3000
```
The production Neon credentials are marked *Sensitive* in Vercel and cannot be pulled locally, which is intentional. For local work, use a separate Neon branch or database.

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
- **New products:** add an entry to `src/data/products.ts`, put the images in `public/images/products/<slug>/`, then run `npm run db:seed`. Seeding never overwrites prices you edited in the admin; use `npx tsx prisma/seed.ts --reset-prices` to restore brochure MRPs.
- Prices start at the brochure MRPs, which are reference data. Check them before launch.

### Testimonials
The brochure contains no customer reviews, so the testimonial section shows a placeholder that invites feedback. Add real, approved quotes to `testimonials` in `src/config/site.ts` and they replace the placeholder automatically.

## Orders and payments
- **Pay on delivery (default):** the order is saved with the status *awaiting confirmation*. The customer is told no payment has been taken and that the team will call to confirm. Manage these in `/admin`.
- **Online payment (Razorpay):** this switches on only when `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. Orders are marked paid only after the Razorpay signature has been verified on the server. Until then, the checkout shows online payment as "coming soon".
- Totals are always recalculated on the server from database prices. Client-side prices are for display only.
- The delivery fee is `site.delivery.fee` (default 0, with a note that charges are confirmed before dispatch).
- Order confirmation pages are private. They need the access token included in the link the customer receives.

## Admin
`/admin` is protected by `ADMIN_PASSWORD` and an HMAC-signed, httpOnly session cookie (`SESSION_SECRET`, at least 24 characters). It covers orders (status updates), enquiries (contact and business), price and stock editing, and the newsletter subscriber count.

## Testing
```bash
npm run dev                                                  # or point BASE_URL at the live site
BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... npm run test:api   # 41 API + page checks
npm run test:ui -- http://localhost:3000                     # 44 browser checks (needs Chrome; set CHROME_PATH)
# afterwards: /admin -> 'Remove test data' (or npm run db:cleanup-tests with a local DB)
```

## Deploying (Vercel)
Deploys go straight from this folder with the Vercel CLI. There is no Git repository, so nothing is public.
```bash
npx vercel@65.2.0 login                     # once per machine
npx vercel@65.2.0 deploy --prod             # build and deploy to https://velora-valley.vercel.app
```
- `vercel.json` pins the Next.js preset, the build command (`npm run vercel-build`) and the region (`sin1`).
- On every deploy, `vercel-build` runs `prisma db push`, which syncs the tables and refuses destructive changes. It then runs the catalogue seed, which upserts and never overwrites prices edited in `/admin`, followed by `next build`. Editing `src/data/products.ts` and redeploying is how you add products.
- Production environment variables (set in Vercel, never in code):

| Variable | Set by | Notes |
| --- | --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (+ other `DATABASE_*`) | Neon integration | Sensitive |
| `SESSION_SECRET` | generated randomly at setup | Sensitive; signs admin sessions |
| `ADMIN_PASSWORD` | you (`npx vercel@65.2.0 env add ADMIN_PASSWORD production --sensitive`) | Sensitive |
| `NEXT_PUBLIC_SITE_URL` | setup | `https://velora-valley.vercel.app`; change it if you add a custom domain |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | you, optional | Enables online payment; redeploy after adding |

  Environment variable changes only take effect after a redeploy.
- The in-memory rate limiter works per serverless instance. Use a shared store such as Upstash Redis if abuse becomes an issue.
- Check the social media URLs in `src/config/site.ts`. They are built from the brochure handle `@veloravalley`.
- Test data: the smoke and UI tests create records named "SMOKE TEST...". Remove them with the **Remove test data** button in `/admin`.

## Content principles
All product facts come from the brochure. Ingredients, nutrition values, certifications, health claims, discounts and reviews have deliberately **not** been invented. Product pages direct customers to the pack label for ingredient, nutrition and allergen information.
