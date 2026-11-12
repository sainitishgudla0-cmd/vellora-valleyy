---
name: review
description: Review the current branch's changes for correctness, security, data-safety and regression risks against Velora Valley rules before committing or closing a task.
---
# /review — pre-commit review

Scope: `git diff backend/development...HEAD` plus uncommitted changes. Read the diff, and only the surrounding code needed to judge it.

Check, in order:
1. **Correctness:** acceptance criteria met; edge cases (empty, duplicate, concurrent, retried requests); state transitions only from valid states; integer paise math.
2. **Data safety:** no `db push` / reset paths; migrations additive or justified by an ADR; scripts call guards; `vercel-build` still DB-free.
3. **Payments:** no state change without verified signal; mock never reachable in preview/production; nothing secret logged.
4. **Security:** Zod at boundaries; server-side authz; constant-time secret comparison; no PII or tokens in logs or URLs; dependency versions exact.
5. **Regressions:** existing API response shapes unchanged (`docs/API-CONTRACTS.md`); frontend files untouched unless allowed; existing tests not weakened or deleted.
6. **Tests:** every behaviour change has a test that would fail without it; no `.only` / `.skip`; no real credentials.
7. **Docs:** API-CONTRACTS, PROGRESS and ADRs are updated where needed and don't duplicate each other.

Report findings as `severity (high/medium/low) · file:line · problem · fix`. High and medium findings block completion unless the user accepts the risk. If nothing is found, say so and list what was checked.
