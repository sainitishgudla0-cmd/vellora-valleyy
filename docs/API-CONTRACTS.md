# API contracts

Canonical inventory of `src/app/api/**`. Update this file in the same commit as any contract change. Money is integer **paise**. Errors are `{ error: string, fields?: Record<string,string> }` (`src/lib/api.ts`); 422 means Zod validation, with `fields`.

## Public

### `GET /api/products`
Query: `q` (≤80 chars), `category` (comma list of category slugs), `sort` (`featured|price-asc|price-desc|name`), `max` (rupees). → `200 { count, products: ProductView[] }` (`src/data/types.ts`). Active products only. *Used by tests only; pages call `src/lib/catalog.ts` directly.*

### `GET /api/products/[slug]`
→ `200 { product: ProductView }` · `404`.

### `POST /api/cart/validate`
Body `{ variantIds: string[] (≤60, each ≤40) }` → `200 { variants: { id, price, mrp, available }[] }` (unknown ids omitted). `available` is derived from units for inventory-tracked variants (M3), the manual flag otherwise; counts are never returned. No rate limit.

### <a id="post-apiorders"></a>`POST /api/orders`
Rate limit 10 per 10 min per IP. Body = `orderSchema` (`src/lib/validation.ts`): customer fields (Indian mobile, 6-digit pincode, state enum) + `paymentMethod: "cod"|"razorpay"` + `items: { variantId, quantity 1..50 }[]` (1..60). Prices, totals, status, provider and payment mode are server-side only: unknown body fields are ignored.
Every order is created with its `Payment` attempt in one insert (M2-T5, ADR 0009).
- **COD (all modes)** `201 { order: { number, token, total } }`: status `pending_confirmation`, `paymentMode=request_only`, one `request_only` attempt (unpaid). Never marked paid automatically.
- **Razorpay (`razorpay_test|razorpay_live`)** `201 { order, payment: { provider: "razorpay", keyId, orderId, amount, currency } }`: status `awaiting_payment`; the gateway order is created after the order/attempt exist, its id/amount/currency are validated and stored on the attempt and `Order.razorpayOrderId`.
- **Mock (`PAYMENT_MODE=mock`, development/test only)**: the `razorpay` method creates a mock order: `201 { order, payment: { provider: "mock", orderId, amount, currency, mock: true, label: "MOCK — no money moved" } }`. No key, signature or confirm credential is ever returned. The storefront does not offer this method in mock mode (`onlinePaymentsEnabled()` is false there); it is exercised by `npm run payments:mock-checkout`.
- `400` method unavailable (online method while online payments are off) · `409` item unavailable or unknown · `422` · `429` · `500`.
- `502 { error }` gateway failure: *definite* (gateway refused, or its answer disagreed on amount/currency/shape): order `cancelled`, attempt `failed`, "No money has been taken". *Unknown outcome* (timeout, 5xx, 429, lost response, failure persisting the reference): `502 { error, orderNumber }`, order kept `awaiting_payment`, attempt flagged `needsReconciliation`; no gateway reference is ever returned to the client, so nothing can be paid. Resolved by `npm run payments:reconcile`.
- **Shipping and GST (M7, ADR 0015):** an order's pincode is checked against the shipping rules (`422 { error: "Sorry, we do not deliver to this pincode yet." }`, nothing created); with no active rule the legacy behaviour is unchanged. The delivery fee comes from the matching rule. Each line also carries a GST snapshot (not in the response). Order notifications are queued in the same transaction.
- **Stock (M3, ADR 0011):** for inventory-tracked variants the units are held in the same transaction as the order. `409 { error }` names the product and variant (`Only 2 of <name> (250g) left in stock…` / `<name> (250g) is out of stock.`) and nothing is created or held. Untracked variants behave as before. Order-number collisions are retried (max 3) before a `503`.
- **`Idempotency-Key` header (optional, M3):** 16-128 chars `[A-Za-z0-9_-]`, else `400`. Same key + same body within 24 h replays the first response (`201`, or the stored `502`) with header `Idempotent-Replayed: true`, creating nothing; same key + different body `422`; a request still being processed `409` + `Retry-After: 2`. A refused order (409) does not consume the key. Without the header every request is an independent order, as before. Only a hash of the key is stored.
- **Wholesale (M6) is a separate path:** `/api/orders` never applies wholesale prices, MOQ or the business account, even for an approved buyer; see `/api/business/*` below.
- **Signed-in shoppers (M5):** with a valid `vv_customer` cookie the order is linked to the account (`Order.customerId`, from the cookie only; body fields are ignored). A missing or invalid cookie is a normal guest order. Response unchanged.
- Unpaid online orders are cancelled after the payment window (default 60 min) by the expiry job below, which releases their stock.

### <a id="payment-verify"></a>`POST /api/payments/razorpay/verify`
Rate limit 20 per 10 min per IP. Body `{ orderNumber, token, razorpay_order_id, razorpay_payment_id, razorpay_signature }`. An order becomes paid only after validation against server records, a valid signature, **and** a server-side gateway lookup showing the payment `captured` for this gateway order with exactly the stored amount and INR.
| Condition | Response | DB write |
|---|---|---|
| order unknown, token wrong, not a Razorpay order (COD, mock, no gateway reference), gateway order id mismatch | `404` | none |
| online payments not configured / invalid config / server not in a Razorpay mode | `503` | none |
| `paymentMode` NULL (legacy, unclassified) · mode differs from the server's · no matching attempt · cancelled or not `awaiting_payment` · amount/currency mismatch · different payment id already paid · payment id belongs to another order/attempt | `409` (logged by order number + code) | none |
| invalid signature | `400` | **none**, and no gateway call |
| gateway says `authorized`/`created` | `202 { ok: false, pending: true }` | attempt flagged for reconciliation; order unchanged |
| gateway unreachable (timeout, 5xx, 429) | `503` | attempt flagged; order unchanged; retry is safe |
| payment unknown to the gateway, or gateway order/amount/currency differs | `409` | attempt flagged (`gateway_mismatch`); order unchanged |
| gateway says `failed` | `400` | attempt and payment `unpaid -> failed` via the state machine (never overwrites paid); order stays `awaiting_payment` |
| `captured`, all checks pass | `200 { ok: true }` | one transaction: attempt `paid` + `transitionOrder` (`awaiting_payment -> paid`, payment `-> paid`, actor `gateway/razorpay`, `OrderEvent`) |
| repeat of the same payment | `200 { ok: true, alreadyVerified: true }` | none |
| concurrent identical requests | all `200`, exactly one transition | one event |
Client (`CheckoutForm`) treats any non-2xx as "payment not completed" (`&payment=failed`); a `202` shows the normal order page (status "Awaiting payment"). Webhooks and refunds are M10.

### `POST /api/enquiries`
Rate limit 6 per 10 min. Body `enquirySchema`: `type: contact|business`, `name`, `email`, `phone?`, `company?`, `city?`, `interest?` (required with `phone` for business: `distributor|retail|bulk|horeca|export|franchise`), `message` 10..2000, `website` honeypot. → `201 { ok, id }` (honeypot: `201 { ok }` and nothing stored) · `422` · `429`.

### `POST /api/newsletter`
Rate limit 8 per 10 min. `{ email }` → `201 { ok }` (idempotent) · `422` · `429`.

### <a id="test-environment"></a>`GET /api/internal/test-environment` (M1)
Write-capable test handshake. **`404` whenever `APP_ENV` resolves to production or preview** (or is contradictory). Otherwise `200 { appEnv, testWritesAllowed: boolean, reasons: string[] }`; `testWritesAllowed` is true only with `TEST_TARGET=disposable` and a loopback or `DISPOSABLE_DB_HOSTS` database. Never returns credentials.

### `GET /api/internal/test-environment/otp?email=` (M8, tests only)
For browser tests, which cannot read an email: the newest mock sign-in code for an address (`200 { code }`). **`404` everywhere except a server that is `APP_ENV` development/test AND `CUSTOMER_OTP_MODE=mock` AND declares a disposable database** (so never preview/production, where mock mode is refused by `env:check`); also `404` for an address with no code. Never returns anything on a real deployment.

### `GET /api/health` (M9, uptime probe)
`200 { ok: true }` when the app can run `SELECT 1` against its database within 3 s, otherwise `503 { ok: false }`. Public, never cached (`Cache-Control: no-store`), and deliberately minimal: no versions, hosts or error text (the failure reason is logged as `health.database_unreachable`). Point the uptime monitor here.

### `GET /api/orders/[number]/invoice?t=<access token>` (M8)
The tax invoice PDF for the holder of the order's access token (the same `t` the order page uses). `404` for a wrong token, an uninvoiced order or an unknown number (identical); `429` rate limited. Headers: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, attachment filename `VV-26-27-000001.pdf`.

## Admin (cookie `vv_admin`; every route calls `requireAdmin(req, permission)` — M4, ADR 0012)
Individual accounts with roles `owner | operations | catalog | viewer`. `401` no/expired/revoked session · `403` role lacks the permission (audited) or a cross-origin mutation (`Origin`/`Sec-Fetch-Site` mismatch; browsers only — header-less script clients pass). Sessions are server-side: logout, deactivation, role change and password change revoke them at once. Permissions: `orders:write` (owner, operations) · `enquiries:write` (owner, operations) · `catalog:write` price/flag (owner, catalog) · `inventory:write` tracking/stock (owner, operations, catalog) · `testdata:write` (owner) · `users:manage` accounts/audit (owner, real accounts only) · `admin:read` reads, own sessions, own password (all roles).
| Route | Body | Result |
|---|---|---|
| `POST /api/admin/login` | `{ email?, password }` | `200 { ok, role }` + `vv_admin` cookie (HttpOnly, SameSite=Lax, 8 h; replaces any session the browser held) · `401` one message for every failure (unknown/disabled/locked/wrong; 5 wrong passwords lock 15 min) · `403` cross-origin · `422` · `429` (8 per 15 min per IP) · `503` `SESSION_SECRET` missing. **Without `email`** it is the transition login with the shared `ADMIN_PASSWORD` → `200 { ok }`, legacy owner-level session without `users:manage`; off with `ADMIN_LEGACY_LOGIN=off`. |
| `POST /api/admin/logout` | — | `200 { ok }`; revokes the session server-side, clears the cookie |
| `GET /api/admin/me` | — | `200 { email, name, role, legacy, permissions[] }` |
| `GET /api/admin/users` | — | `200 { users[] }` (no hashes) · `403` non-owner |
| `POST /api/admin/users` | `{ email, name, role, password }` (strict) | `201 { user }` · `409 email_in_use` · `422` weak password/invalid |
| `PATCH /api/admin/users/[id]` | `{ role?, active?, name?, unlock?: true, password? }` (strict, ≥1) | `200 { ok, sessionsRevoked }` · `404` · `409 last_owner` (the last active owner cannot be demoted/deactivated) · `422`. Role/active/password changes end the person's sessions. |
| `GET /api/admin/sessions[?all=1]` | — | `200 { sessions[{ id, email, legacy, userAgent, createdAt, lastSeenAt, expiresAt, current }] }`; `all` is honoured for owners only; never tokens |
| `DELETE /api/admin/sessions/[id]` | — | `200 { ok, revoked }` own session, or any (owner); otherwise `404` |
| `POST /api/admin/account/password` | `{ currentPassword, newPassword }` | `200 { ok, sessionsRevoked }` (other sessions end) · `422` · `409` shared-password session · `429` |
| `GET /api/admin/audit[?limit≤200&before=<ISO>&action=]` | — | `200 { entries[] }` newest first (owner only; read-only, no write routes) |
| `PATCH /api/admin/orders/[id]` | `{ status?, paymentStatus?, reason? (≤500), paymentReference? (3-80) }` (enums; unknown values `422`) | `200 { ok }` (also for an unchanged/empty request) · `401` · `404` · `422 { fields }` reason or reference missing/malformed · `409 { error, code }` invalid transition, admin not allowed (e.g. marking an order paid), stale, payment edit not allowed, no payment record, reference already used. **Every change goes through the order state machine (M2-T6, ADR 0010)**: one transaction, an `OrderEvent` (actor `admin`, reason, payment reference) per change. See below. |
| `PATCH /api/admin/variants/[id]` (price/`inStock` need `catalog:write`, tracking/stock need `inventory:write`; `403` otherwise) | `{ price?: rupees (>0, ≤100000), inStock?: boolean, trackInventory?: boolean (needs reason 3-200), reason?, stockAdjust?: { delta: non-zero integer (±100000), reason 3-200 } }` | `200 { ok, price (paise), inStock (derived when tracked), trackInventory, stockQuantity?, reserved?, available? }` (count fields only when tracked) · `401` · `404` · `422` · `409 { error, code }` `not_tracked` / `negative_stock` / `below_reserved` / `reserved_open`. `inStock` is ignored for tracked variants. Inventory changes are atomic, audited in `InventoryMovement` (actor `admin`), applied before the price. (M3, ADR 0011) |
| `GET /api/admin/variants/low-stock?threshold=5` | — | `200 { threshold, variants: { variantId, sku, product, label, stockQuantity, reserved, available }[] }` tracked variants of active products with `available <= threshold`, lowest first · `401` · `422` bad threshold (0-10000) |
| `PATCH /api/admin/enquiries/[id]` | `{ status: new|in_progress|closed }` | `200 { ok }` · `404` |
| `DELETE /api/admin/test-data` | — | `200 { ok, orders, enquiries, subscribers }`: deletes `SMOKE TEST` / `smoke.` records |

## Pages with backend reads
`/order/[number]?t=<accessToken>` (404 without the matching token) · `/admin?tab=orders|enquiries|products` · `/checkout` (reads `onlinePaymentsEnabled()`, `site.allowCashOnDelivery`).

## Status vocabularies (Postgres enums since M2-T1, ADR 0005; JSON values are the same strings as before)
- Order `status`: `pending_confirmation | awaiting_payment | confirmed | paid | dispatched | delivered | cancelled`
- `paymentStatus`: `unpaid | paid | failed | refunded` · `paymentMethod`: `cod | razorpay` (`cod` = pay-on-delivery request: stays `unpaid` until externally confirmed)
- Enquiry `status`: `new | in_progress | closed`

## Order state machine (M2-T2, ADR 0006)
Internal module only; no HTTP contract changes yet. `OrderEvent` rows are written by `transitionOrder`. Routes are moved onto it in M2-T5/T6 (admin PATCH will then return `409` for invalid transitions).

## Payment providers (M2-T3, ADR 0007)
Internal modules only; no HTTP contract changes. `Payment` rows are not written by any route yet (M2-T5).

## Mock payment confirm
`POST /api/payments/mock/confirm` (ADR 0008). **Development/test only**: `404` unless the server's resolved `PAYMENT_MODE` is `mock` and `APP_ENV` is `development|test`, and `MOCK_PAYMENT_CONFIRM_KEY` (24+ chars) is set. Not used by the storefront.
- Headers: `x-mock-confirm-key: <MOCK_PAYMENT_CONFIRM_KEY>`. Rate limit 30 per 10 min per IP (checked before the key).
- Body (strict, extra fields -> `422`): `{ orderNumber, token, providerOrderId, providerPaymentId, signature }` where the last three are the mock provider's deterministic identifiers/proof.
- `200 { ok, mock: true, label: "MOCK — no money moved" }` (first confirmation) · `200 { ok, alreadyConfirmed: true, mock, label }` (idempotent repeat) · `400` invalid proof · `401` missing/wrong key · `404` disabled environment/mode, unknown order, wrong token, or an order/attempt not created as mock (request-only, Razorpay, legacy NULL) · `409` cancelled/not payable, amount or currency mismatch, different payment id, stale · `422` · `429`.
- Writes (one transaction): `Payment` unpaid -> paid with `providerPaymentId`, order `awaiting_payment -> paid` / payment `unpaid -> paid` via the state machine, one `OrderEvent` (`system`/`mock-provider`). Nothing else changes; Razorpay columns stay NULL.

## Order payment mode (M2-T4)
`Order.paymentMode`: `request_only` (all pay-on-delivery orders) · `mock` · `razorpay_test` · `razorpay_live` · `NULL` (legacy, unclassified). Set server-side at creation. Not in any response body today; the order page and admin show `MOCK — no money moved` for `mock`.

## Reconciliation (M2-T5, ADR 0009)
`npm run payments:reconcile` (operator, guarded like `db:*`; production needs the explicit confirmation) processes attempts flagged `needsReconciliation` for the current Razorpay mode: completes captured payments through the same code as `/verify`, attaches a gateway order found by receipt after a lost create response, cancels never-created orders only after 30 minutes and a successful empty lookup, and clears flags when nothing is settling. Prints counts only.

## Admin order and payment changes (M2-T6, ADR 0010)
- **Status:** only graph transitions (`pending_confirmation → confirmed|cancelled`, `confirmed|paid → dispatched|cancelled`, `dispatched → delivered|cancelled`, `awaiting_payment → cancelled`). Admins can never set `paid`, `awaiting_payment` or leave `delivered`/`cancelled`. A plain status change records the reason "Status changed from the admin dashboard" unless `reason` is given; cancelling an order whose payment is `paid` requires an explicit `reason` (`422`).
- **Manual payment confirmation** (`{ paymentStatus: "paid", reason, paymentReference }`): only for request-only (pay-on-delivery) orders with a request-only payment record, payment-only (no simultaneous status change), `unpaid → paid`. Stores the reference on the `Payment` (`manualReference`, unique: one external payment cannot confirm two orders) and on the event. Never for Razorpay, mock or legacy (mode NULL) orders, and never on cancelled orders.
- **Refund bookkeeping** (`{ paymentStatus: "refunded", reason }`): `paid → refunded` records that a refund was made outside the system (real refunds are M10). `refunded` is terminal.
- All other payment edits are refused (`409 payment_edit_not_allowed`). Orders with no payment record, and legacy orders, need operator reconciliation.
- The admin dashboard dropdown (status only) is unchanged; a rejected move shows the existing "Error" and reverts. There is no admin UI yet for entering a payment reference (needs a UI approval); the endpoint is API-only.

## Inventory and expiry (M3, ADR 0011)
- Tracking is per variant (`trackInventory`, default off = legacy manual `inStock`). Tracked: available = `stockQuantity - reserved`; order creation reserves, cancel/expiry before dispatch releases, dispatch consumes stock. All through `InventoryMovement` (append-only; SUM = counters); DB CHECKs forbid negative stock and over-reservation.
- `GET /api/internal/orders/expire` (Vercel Cron GET, `Authorization: Bearer $CRON_SECRET`): `404` unless `CRON_SECRET` is 24+ chars · `401` wrong/missing bearer · `503` payments misconfigured · `200 { ok, checked, expired, paid, pending, skipped, errors, keysDeleted, quotesExpired }` (counts only). Cancels unpaid online orders older than `PAYMENT_WINDOW_MINUTES` (default 60, min 15) after asking the gateway (captured -> marked paid; authorized -> left; unreadable -> skipped). Never touches pay-on-delivery orders. Also deletes idempotency keys past 24 h and marks wholesale quotes past their validity `expired` (`quotesExpired`).

## Admin audit (M4, ADR 0012)
Every admin login, logout, mutation (success or rejected) and denial writes an `AuditLog` row: `action` (`login.success|failure|locked`, `logout`, `order.update`, `enquiry.update`, `variant.update`, `testdata.delete`, `user.create|update`, `session.revoke`, `password.change`, `access.denied`, `request.cross_origin`, `owner.bootstrap`, `owner.password_reset`), `outcome` (`success|rejected|denied|failed`), actor (account id, email or `legacy`/`anonymous`, role), target and a small `details` JSON of ids/field names (never passwords, tokens, reasons or customer data). `OrderEvent.actorId` and inventory ledger `actorId` now hold the account id (`legacy` for the shared password; older rows say `admin`).

## Customer accounts (M5, ADR 0013) — `/api/account/*`
Sign-in is an emailed one-time code (no password). Delivery is a mock until M7: **`POST otp/request` answers `503` whenever no sender is configured (always in preview/production for now)**. Cookie `vv_customer` (HttpOnly, SameSite=Lax, 30 days absolute / 14 idle, server-side, revocable). Every route except `otp/*` and `logout` needs a session (`401`); mutations are same-origin checked (`403`); the customer is always the session's, never a request field. Request bodies are strict (unknown fields `422`). Another customer's id/number is `404`, identical to a missing one.
| Route | Body / query | Result |
|---|---|---|
| `POST /api/account/otp/request` | `{ email }` | `202 { ok, message }` for any address (no enumeration) · `422` · `429` per-IP, resend cooldown 30 s (`Retry-After`) or 5 codes/hour/address · `503` no sender / `SESSION_SECRET` missing |
| `POST /api/account/otp/verify` | `{ email, code (6 digits), acceptTerms?, marketing? }` | `200 { ok, created }` + cookie · `401` one generic message (wrong/expired/used/exhausted: 5 guesses per code) · `409 { code: "terms_required" }` first sign-in without `acceptTerms` (the code stays usable) · `422` · `429` |
| `POST /api/account/logout` | `{ everywhere?: true }` | `200 { ok }`, session(s) revoked, cookie cleared |
| `GET /api/account/me` · `PATCH` | `{ name?, phone? }` (nullable, strict; email is read-only) | `{ customer: { id, email, name, phone, marketingConsent, createdAt, lastLoginAt, consents[] } }` |
| `POST /api/account/consent` | `{ marketing: boolean }` | `200 { ok, marketing, changed }`; each change appended to the consent history |
| `GET/POST /api/account/addresses` · `PATCH/DELETE …/[id]` | address (name, phone, line1, line2?, city, state, pincode, label?, isDefault?) | `{ addresses[] }` · `201 { address }` · `409 limit_reached` (10) · first address is the default; one default always · `404` for another customer's id |
| `GET /api/account/orders?limit≤50&cursor=` | — | `{ orders[{ number, createdAt, status, paymentMethod, paymentStatus, total, itemCount }], nextCursor }` newest first · `422` bad cursor/limit |
| `GET /api/account/orders/[number]` | — | `{ order: { number, createdAt, status, paymentMethod, paymentStatus, isMockPayment, subtotal, deliveryFee, total, shipping, notes, items[], history[{ from, to, paymentStatus, at }], shipments[{ courier, awb, trackingUrl, status, events[{ status, at }] }], invoice: { number, issuedAt } \| null } }`; never the access token, gateway ids, actor ids or reasons · `404` |
| `POST /api/account/claim` | `{ mode: "email" }` or `{ orderNumber, token }` | `200 { ok, claimed }`: links unclaimed guest orders placed with the verified email, or one order proven by its guest token; never re-links an order · `404` wrong token / not found / someone else's · `429` |
| `GET /api/account/export` | — | JSON download (profile, addresses, consents, orders incl. guest orders under the same email, enquiries, newsletter); no secrets; `429` 5/hour |
| `DELETE /api/account` | `{ confirm: "DELETE" }` | `200 { ok, ordersAnonymised }` + cookie cleared · `403 reauth_required` (sign-in older than 10 min) · `409 open_orders { openOrders }` or `409 business_account` (live business account: staff must close it first) · `422`. Orders/enquiries anonymised, account data deleted. |
Claims, consent changes, exports and deletions are audited (`customer.*`, actor `customer:<id>`).

## Wholesale (M6, ADR 0014)
All money is integer **paise**. A *buyer* is a signed-in customer (M5) with an APPROVED business account. Quantities per line up to 100,000 (retail stays at 50).

### Customer side — `/api/business/*`
`apply` and `account` need only a customer session; everything else is behind `requireBusiness`: `401` no session · `403 { code: "business_account_required" }` (no account) · `403 { code: "business_account_not_active", status }` (pending/rejected/suspended/closed). Mutations are same-origin checked. Account, price list and quote come from the session, never the request; another account's quote number is `404`. Bodies are strict (unknown fields `422`).
| Route | Body | Result |
|---|---|---|
| `POST /api/business/apply` | `{ companyName, gstin, contactName, phone, interest?, message? }` | `201 { account: { status: "pending", companyName, gstin } }` · `409 already_applied` / `gstin_in_use` · `422` bad GSTIN (format + check character) · `429`. A rejected applicant may re-apply. |
| `GET /api/business/account` | — | `{ account: { status, companyName, gstin, contactName, phone, paymentTerms, creditLimit?, approvedAt, createdAt } }` (no staff note) · `404` |
| `GET /api/business/price-list` | — | `{ paymentTerms, items: [{ variantId, sku, product, label, retailPrice, moq, casePack, tiers: [{ minQty, unitPrice }] }] }`: only THIS account's active list |
| `POST /api/business/cart/validate` | `{ items: [{ variantId, quantity }] }` | `{ lines: [{ variantId, quantity, available, unitPrice, lineTotal, priceSource: "list"\|"retail", moq, casePack, problem }], subtotal }` |
| `POST /api/business/orders` | customer/delivery fields + `items` (no `paymentMethod`, no prices) · optional `Idempotency-Key` | `201 { order: { number, token, total } }`; prices from the buyer's tiers (else retail), MOQ/case pack enforced, stock held, credit limit for credit terms; offline payment (request-only), `Order.businessAccountId` set · `422` MOQ/case pack (names the item) · `409` stock/credit limit/unavailable · `429` |
| `GET/POST /api/business/quotes` | `{ items: [{ variantId, quantity }], note? }` | list · `201 { quote }` (status `requested`, no prices) · `422` (MOQ etc., `fields`) |
| `GET /api/business/quotes/[number]` · `DELETE` | — | `{ quote: { number, status, requestNote, buyerNote, validUntil, orderNumber, items[], subtotal?, deliveryFee?, total? } }` (prices only once quoted) · `DELETE` withdraws before acceptance · `409 invalid_transition` |
| `POST /api/business/quotes/[number]/accept` | customer/delivery fields (strict) | `201 { order: { number, token, total } }` at exactly the quoted prices and delivery fee; one transaction with the quote's move to `accepted` · `409` `quote_expired` / `invalid_transition` / stock / credit limit (quote stays `quoted`) |
| `POST /api/business/quotes/[number]/decline` | — | `200 { ok }` · `409` |
Quote statuses: `requested -> quoted (re-quotable) -> accepted \| declined \| expired \| cancelled`; `requested -> rejected \| cancelled`. Retail endpoints are unchanged and carry no wholesale data.

### Admin side (permissions: `wholesale:read` owner/operations/catalog · `wholesale:write` owner/operations · `pricing:write` owner/catalog; every mutation audited)
| Route | Body | Result |
|---|---|---|
| `GET /api/admin/wholesale/accounts[?status=&limit=]` · `GET …/[id]` | — | accounts (incl. staff note, `linkedToCustomer`) · detail with order/quote counts |
| `PATCH /api/admin/wholesale/accounts/[id]` | `{ status?, priceListId?, paymentTerms?, creditLimit? (paise), adminNote? }` (strict, ≥1) | `200 { ok, account }` · `409 invalid_transition`/`stale_state` (graph: pending→approved/rejected/closed, approved↔suspended, suspended→closed, rejected→approved, closed terminal) · `422` credit terms need a limit, unknown/inactive price list · closing cancels open quotes |
| `POST /api/admin/enquiries/[id]/convert` | `{ companyName, gstin, approve?, priceListId?, paymentTerms?, creditLimit? }` | `201 { ok, accountId, status }` · `409 account_exists`/`gstin_in_use`/`not_a_business_enquiry` · `422` · the enquirer is linked when they sign in with that email |
| `GET/POST /api/admin/price-lists` · `GET/PATCH/DELETE …/[id]` | `{ name, description? }` · `{ name?, description?, active? }` | `409 name_in_use`; `DELETE` only when no account uses it (`409 in_use`) |
| `PUT /api/admin/price-lists/[id]/items` | `{ variantId, tiers: [{ minQty, unitPrice }] }` replaces all tiers of that variant (`[]` removes) | `422` duplicate `minQty`, price rising with quantity, above MRP, non-positive |
| `PUT /api/admin/variants/[id]/wholesale` | `{ moq, casePack }` (1/1 = none) | `200 { ok, moq, casePack }` |
| `GET /api/admin/quotes[?status=]` · `GET …/[id]` | — | queue · full quote with events |
| `PATCH /api/admin/quotes/[id]` | `{ action: "quote", items: [{ variantId, unitPrice }], deliveryFee?, validDays? (1-30, default 7), buyerNote? }` or `{ action: "reject" \| "cancel" }` | prices every requested line once (positive, ≤ MRP) · `409 invalid_transition` · `422` |

## GST, invoices, shipping, shipments, notifications (M7, ADR 0015)
Amounts are integer paise; prices are GST-inclusive. Permissions: `fulfilment:read` and `fulfilment:write` (owner, operations), `tax:write` (owner only). Every mutation is audited (ids and field names only).
| Route | Body / query | Result |
|---|---|---|
| `GET /api/shipping/quote?pincode=&subtotal=` (public, rate limited) | `pincode` 6 digits, `subtotal` paise (default 0) | `200 { serviceable, fee, freeAboveSubtotal, ruleBased }`: exactly what `POST /api/orders` would apply (`ruleBased` false = no shipping rules exist, the site default fee applies and delivery is "to be confirmed") · `422` · `429` |
| `GET/POST /api/admin/tax-rates` | `{ code: HSN (4/6/8 digits) \| "DELIVERY", rateBp (0-5000), effectiveFrom: "YYYY-MM-DD", note? }` | list · `201` · `409 rate_exists` (append-only per code and date) · `422`; POST needs `tax:write` |
| `GET/POST /api/admin/shipping-rules` · `PATCH/DELETE …/[id]` | `{ name, pincodePrefix (0-6 digits), serviceable?, fee?, freeAboveSubtotal?, active? }` (PATCH: only what is sent) | `{ rules[], legacyMode }` · `409 prefix_in_use` · `422`. No active rule = legacy (everywhere, site fee); any active rule = a pincode needs a matching rule (longest prefix; empty prefix = catch-all) |
| `POST /api/admin/orders/[id]/invoice` | — | `201 { invoice: { id, number, issuedAt, total, supplyType } }` · `200` repeat (idempotent) · `409 { code, detail[] }` `seller_not_configured` / `tax_not_configured` (lists HSN codes) / `order_not_invoiceable` · `404` |
| `GET /api/admin/invoices[?fy=2026-27&limit=]` · `GET …/[id][?format=json]` | — | list with totals · the PDF (default, identical every time) or the frozen payload |
| `GET /api/account/orders/[number]/invoice` | — | the customer's own invoice as a PDF attachment · `404` for someone else's, uninvoiced or unknown (identical) · `401` |
| `GET/POST /api/admin/orders/[id]/shipments` | `{ courier, awb (4-40 letters/digits/dashes), trackingUrl? (https) }` | `201 { shipmentId }` for confirmed/paid/dispatched orders · `409 order_not_shippable` / `awb_in_use` · does not change the order status |
| `PATCH /api/admin/shipments/[id]` | `{ status, note? }` | graph: created -> picked_up/in_transit/failed; picked_up -> in_transit/failed/returned; in_transit -> out_for_delivery/delivered/failed/returned; out_for_delivery -> delivered/failed/in_transit; failed -> in_transit/returned · `409 invalid_transition` |
| `GET /api/admin/outbox[?status=]` · `POST …/[id]/retry` | — | the notification queue (templates and ids only, never recipients or content) · puts a failed/dead message back |
| `GET /api/internal/outbox/process` | `Authorization: Bearer $CRON_SECRET` | `404` unless CRON_SECRET is 24+ chars · `401` wrong bearer · `200 { ok, claimed, sent, retried, dead, skipped }`. Sends nothing unless `NOTIFY_MODE` allows a provider (never in production yet). |
State machine: cancelling an order that has an invoice is refused (`409 invoice_issued`; a credit note would be needed). Order status moves queue the matching notification (`order_confirmed`, `order_paid`, `order_dispatched`, `order_delivered`, `order_cancelled`) when notifications are on.
