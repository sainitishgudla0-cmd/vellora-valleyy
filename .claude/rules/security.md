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
- Admin and customer authorization is checked server-side on every request; never rely on the UI hiding a control.
- New dependencies: exact versions only, justified in the PR, and `npm audit --omit=dev` must stay clean.
- Environment checks fail closed: if the environment or target can't be identified, refuse.
