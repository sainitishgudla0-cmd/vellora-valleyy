# ADR 0021 — Critical audit rows are written in the change's transaction (fail closed)

- **Status:** accepted (M11 P1-T4, finding F07), 2026-11-20
- **Context:** `writeAudit` (M4, ADR 0012) swallows database errors so that an audit hiccup never turns a finished mutation into an error. For money, payment state, accounts, roles and credentials that means a change could commit with no record of who made it.

## Decision
1. Two classes of audit:
   - **Critical** (`CRITICAL_AUDIT_ACTIONS` in `src/lib/auth/audit.ts`): `order.update` (any real order status/payment change), `order.refund.requested`, `user.create`, `user.update`, `user.password_reset`, `password.change`. Their **success** row is written with `writeAuditTx(tx, …)` inside the transaction that makes the change. The insert is never caught: if it fails the transaction, and so the change, rolls back and the route answers `500`.
   - **Best-effort** (everything else, and every rejection/denial/login row): unchanged `writeAudit`; a failed write is logged without its contents.
2. The owning library function writes the critical row, so every caller (routes, `admin:bootstrap`, tests) records it; the audit actor is a required argument (`AuditActor`).
3. Refunds: `order.refund.requested` is committed with the `Refund` ledger row **before** the gateway call, so money never moves without evidence of who asked. The gateway outcome is still written afterwards as `order.refund` (best-effort): the ledger row itself is the durable record of the outcome.
4. Not critical, deliberately: session revocation and logout (they only remove access; failing them closed would keep a session alive because of an audit problem), catalogue, fulfilment, wholesale and tax edits (best-effort as before; candidates for a later pass).
5. Ratchet: `tests/unit/audit-critical-ratchet.test.ts` fails if any `writeAudit({ action: <critical>, outcome: "success" })` appears in `src/` or `scripts/`, and checks each critical action is written with `writeAuditTx` by its owning module.

## Consequences
- An `AuditLog` outage now blocks critical admin changes (by design) and nothing else.
- A combined user PATCH (fields + password) runs two transactions and writes two rows (`user.update`, `user.password_reset`); a failure in the second leaves the first committed and audited.
- Evidence: `tests/integration/audit-critical.test.ts` injects an `AuditLog` insert failure (temporary trigger, disposable DB) for each critical action and asserts the change rolled back and a retry commits exactly one row.
