# ADR 0010 — Admin order changes go through the state machine

- **Status:** accepted (M2-T6, 2026-11-12)
- **Context:** `PATCH /api/admin/orders/[id]` wrote any status/paymentStatus straight to the database: an admin (or a mis-click) could mark any order paid, reopen a delivered order or cancel a paid one with no history.
- **Decisions**
  - `updateOrderAsAdmin` (service) -> `transitionOrder` (actor `admin`, id `admin`: there is a single shared admin credential, so the event cannot name a person). Invalid transitions are `409`, missing reason/reference `422`. The route is thin and keeps `200 { ok }` / `401` / `404` / `422` for existing callers; the dashboard dropdown needed no change.
  - **Orders never become `paid` by hand** (the order graph already makes `paid` reachable only from `awaiting_payment`, and the actor rule allows only gateway/system there).
  - **Manual payment confirmation** exists for request-only orders only: payment-only change, explicit reason, an external reference matching `^[A-Za-z0-9][A-Za-z0-9 _./:-]{2,79}$`, recorded on `Payment.manualReference` (unique) and on the `OrderEvent`. A DB CHECK stops any non-request-only attempt carrying a manual reference. Gateway and mock payments cannot be confirmed by hand, which keeps the T5 rule that online payments are proven by the provider.
  - **Refund bookkeeping** (`paid -> refunded`, reason required) records an external refund; no money moves here (M10).
  - The `Payment` row and the order change commit in one transaction; any failure (including the event insert) rolls both back. Conditional updates make concurrent identical requests produce one event.
  - Plain status moves get a default recorded reason so the existing dropdown keeps working; payment edits and cancelling a paid order require a human-written one.
  - The ratchet's legacy status-writer list is now empty.
- **Consequences:** the roadmap AC "no code writes `Order.status`/`paymentStatus` outside the state machine" is met for application code (orders are still *created* with initial statuses, and `reconcile`/`checkout` attach the Razorpay reference without touching status). Admin UI for entering a payment reference is not built (frontend approval needed). The audit trail names the role, not the person, until M4 introduces individual admin accounts.
