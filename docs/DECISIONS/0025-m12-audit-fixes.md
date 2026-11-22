# ADR 0025: M12 independent-audit fixes

Status: accepted (2026-11-22). Findings, evidence and blockers: `docs/M12-INDEPENDENT-AUDIT.md`.

## Decisions
1. **Personal data follows the account, not the email string (VA-01).** Export, erasure and the open-order check use
   `customerId = me OR (customerId IS NULL AND email ILIKE my verified email)`. An order linked to another account is
   theirs even when it carries my address.
2. **Never change a requested quantity (VA-02).** Duplicate lines are merged; a merged line over the cap (50 retail,
   100,000 wholesale) is a `422`, not silently capped.
3. **Wholesale terms are read where they are enforced (VA-03).** `createOrder` locks the `BusinessAccount` row
   (`FOR UPDATE`) and re-reads it inside the order transaction for every wholesale order and quote acceptance; the price
   and credit hooks receive that row. Staff edits update the same row, so they serialise with orders. Lock order is
   account → variants, and nothing locks a variant before an account, so no new deadlock cycle.
4. **One request, one admin change (VA-04).** `updateUser` takes the optional password; it is validated and hashed first,
   then fields, password, session revocation and both audit rows are one transaction. The self-service change is a
   compare-and-set on the verified hash. `resetPassword` was removed (no other caller).
5. **Financial configuration is critical audit (VA-05, extends ADR 0021).** GST rates, shipping rules, price lists and
   tiers, retail price (`variant.price`, with from/to), MOQ/case packs, business-account terms/limits and enquiry
   conversion are `CRITICAL_AUDIT_ACTIONS`, written with `writeAuditTx`; the ratchet names each owning module. Quote
   pricing is already evidenced by `QuoteEvent` rows in its transaction, invoices by the gap-free `Invoice` row; neither
   changed. Stock changes keep their `InventoryMovement` ledger.
6. **Sign-in code issuance is serialised per address (VA-06)** with `pg_advisory_xact_lock(hashtextextended('otp:'||hash))`
   around the cap/cooldown checks, retiring old codes and inserting the new one. The email is sent after commit; a failed
   send deletes the row as before.
7. **Invoice PDF stays dependency-free (VA-07).** Embedding Unicode fonts with Indic shaping would replace the writer.
   Instead `toPdfText` maps text to WinAnsi: NFC, typographic punctuation to its WinAnsi glyph, the nine Brahmic scripts
   of India transliterated through one ISCII-ordered table, Latin diacritics folded, anything else one `?` per character.
   The frozen invoice payload keeps the original text. A native-script invoice would need an embedded font (future work).
8. **Rate-limit key trusts only known proxies (VA-08).** `clientIp`: on Vercel the address Vercel sets; elsewhere the
   entry `TRUSTED_PROXY_HOPS` (default 1) from the right of `X-Forwarded-For`; too few entries = one shared `untrusted`
   key. The Origin check was reviewed and kept: browsers cannot send `X-Forwarded-Host` cross-site without a preflight,
   and session cookies are `Secure`, so adding a scheme check would only risk refusing legitimate proxied requests.
9. **Money fits the columns (M12-A01).** Lines, subtotals and totals above `2^31-1` paise are refused with `422` (orders
   and quote pricing) instead of failing the insert with a `500`. Widening the columns to BIGINT is a schema change left
   for when a business needs single orders above ₹2.1 crore.

## Consequences
- Wholesale orders for one account are serialised (they already were for credit accounts).
- Some admin requests that used to succeed after a failed audit insert now fail with `500` and change nothing.
- Deployments off Vercel must set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app.
