---
paths:
  - "src/app/**/page.tsx"
  - "src/app/layout.tsx"
  - "src/components/**"
  - "src/styles/**"
  - "src/store/**"
  - "tailwind.config.ts"
  - "public/**"
---
# Frontend preservation

The customer-facing UI is finished and approved. Backend milestones must not change its look, copy, layout or animation.
- Only edit these files when the task explicitly requires an integration change (e.g. M8), and keep the diff minimal and functional.
- Keep existing API response shapes backward-compatible; add fields rather than renaming or removing them.
- Don't read or list `public/images/**`; asset paths come from `src/data/*.ts`.
- If an integration needs new UI, stop and record it in `docs/PROGRESS.md` as a blocker for the user to approve.
- The admin area (`src/app/admin/**`, `src/components/admin/**`) is internal UI: M4-T6 added the Account and Team tabs and the email login field. Keep its existing controls and look; new admin UI still needs approval.
- M8 (approved) made these customer-facing changes, all minimal and functional: checkout messages, idempotent submits and a live delivery quote (`CheckoutForm`), tracking and invoice download on the order page, and new pages `/account` and `/account/orders/[number]` (sign-in, orders, addresses, wholesale portal, privacy). **Header and footer were NOT touched**: links to `/account` wait for design approval. Existing pages are guarded by `tests/e2e/visual.spec.ts` (pixel diff against baselines captured before the change; baselines are local, large and gitignored: capture them from a clean checkout with `npx playwright test visual --update-snapshots` BEFORE editing a page, compare after).
