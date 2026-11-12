# API contracts

Canonical inventory of `src/app/api/**`. Update this file in the same commit as any contract change. Money is integer **paise**. Errors are `{ error: string, fields?: Record<string,string> }` (`src/lib/api.ts`); 422 means Zod validation, with `fields`.

## Public

### `GET /api/products`
Query: `q` (≤80 chars), `category` (comma list of category slugs), `sort` (`featured|price-asc|price-desc|name`), `max` (rupees). → `200 { count, products: ProductView[] }` (`src/data/types.ts`). Active products only. *Used by tests only; pages call `src/lib/catalog.ts` directly.*

### `GET /api/products/[slug]`
→ `200 { product: ProductView }` · `404`.

### `POST /api/cart/validate`
Body `{ variantIds: string[] (≤60, each ≤40) }` → `200 { variants: { id, price, mrp, available }[] }` (unknown ids omitted). No rate limit.

### <a id="post-apiorders"></a>`POST /api/orders`
Rate limit 10 per 10 min per IP. Body = `orderSchema` (`src/lib/validation.ts`): customer fields (Indian mobile, 6-digit pincode, state enum) + `paymentMethod: "cod"|"razorpay"` + `items: { variantId, quantity 1..50 }[]` (1..60). Prices, totals, status, provider and payment mode are server-side only: unknown body fields are ignored.
Every order is created with its `Payment` attempt in one insert (M2-T5, ADR 0009).
- **COD (all modes)** `201 { order: { number, token, total } }`: status `pending_confirmation`, `paymentMode=request_only`, one `request_only` attempt (unpaid). Never marked paid automatically.
- **Razorpay (`razorpay_test|razorpay_live`)** `201 { order, payment: { provider: "razorpay", keyId, orderId, amount, currency } }`: status `awaiting_payment`; the gateway order is created after the order/attempt exist, its id/amount/currency are validated and stored on the attempt and `Order.razorpayOrderId`.
- **Mock (`PAYMENT_MODE=mock`, development/test only)**: the `razorpay` method creates a mock order: `201 { order, payment: { provider: "mock", orderId, amount, currency, mock: true, label: "MOCK — no money moved" } }`. No key, signature or confirm credential is ever returned. The storefront does not offer this method in mock mode (`onlinePaymentsEnabled()` is false there); it is exercised by `npm run payments:mock-checkout`.
- `400` method unavailable (online method while online payments are off) · `409` item unavailable or unknown · `422` · `429` · `500`.
- `502 { error }` gateway failure: *definite* (gateway refused, or its answer disagreed on amount/currency/shape): order `cancelled`, attempt `failed`, "No money has been taken". *Unknown outcome* (timeout, 5xx, 429, lost response, failure persisting the reference): `502 { error, orderNumber }`, order kept `awaiting_payment`, attempt flagged `needsReconciliation`; no gateway reference is ever returned to the client, so nothing can be paid. Resolved by `npm run payments:reconcile`.
- Duplicate submissions create independent orders (idempotency keys and stock reservation are M3).

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

## Admin (cookie `vv_admin`, via `isAdmin()`; `401` otherwise)
| Route | Body | Result |
|---|---|---|
| `POST /api/admin/login` | `{ password }` | `200 { ok }` + cookie · `401` · `429` (8 per 15 min) · `503` not configured |
| `POST /api/admin/logout` | — | `200 { ok }` (clears cookie; stateless, no server revocation) |
| `PATCH /api/admin/orders/[id]` | `{ status?, paymentStatus?, reason? (≤500), paymentReference? (3-80) }` (enums; unknown values `422`) | `200 { ok }` (also for an unchanged/empty request) · `401` · `404` · `422 { fields }` reason or reference missing/malformed · `409 { error, code }` invalid transition, admin not allowed (e.g. marking an order paid), stale, payment edit not allowed, no payment record, reference already used. **Every change goes through the order state machine (M2-T6, ADR 0010)**: one transaction, an `OrderEvent` (actor `admin`, reason, payment reference) per change. See below. |
| `PATCH /api/admin/variants/[id]` | `{ price?: rupees (>0, ≤100000), inStock?: boolean }` | `200 { ok, price (paise), inStock }` · `404` |
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
