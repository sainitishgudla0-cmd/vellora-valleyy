# API contracts

Canonical inventory of `src/app/api/**`. Update this file in the same commit as any contract change. Money is integer **paise**. Errors are `{ error: string, fields?: Record<string,string> }` (`src/lib/api.ts`); 422 means Zod validation, with `fields`.

## Public

### `GET /api/products`
Query: `q` (≤80 chars), `category` (comma list of category slugs), `sort` (`featured|price-asc|price-desc|name`), `max` (rupees). → `200 { count, products: ProductView[] }` (`src/data/types.ts`). Active products only. *Used by tests only; pages call `src/lib/catalog.ts` directly.*

### `GET /api/products/[slug]`
→ `200 { product: ProductView }` · `404`.

### `POST /api/cart/validate`
Body `{ variantIds: string[] (≤60, each ≤40) }` → `200 { variants: { id, price, mrp, available }[] }` (unknown ids omitted). No rate limit.

### `POST /api/orders`
Rate limit 10 per 10 min per IP. Body = `orderSchema` (`src/lib/validation.ts`): customer fields (Indian mobile, 6-digit pincode, state enum) + `paymentMethod: "cod"|"razorpay"` + `items: { variantId, quantity 1..50 }[]` (1..60).
- `201 { order: { number, token, total } }` (COD, status `pending_confirmation`).
- `201 { order, payment: { provider: "razorpay", keyId, orderId, amount, currency } }` (online, status `awaiting_payment`; only when `onlinePaymentsEnabled()`).
- `400` method unavailable · `409` item unavailable or unknown · `422` · `429` · `502` Razorpay order creation failed (order set to `cancelled` / `failed`) · `500`.

### <a id="payment-verify"></a>`POST /api/payments/razorpay/verify`
Rate limit 20 per 10 min per IP (added M1). Body `{ orderNumber, token, razorpay_order_id, razorpay_payment_id, razorpay_signature }`.
| Condition | Response | DB write |
|---|---|---|
| order unknown, token wrong, not a Razorpay order, gateway order id mismatch | `404` | none |
| online payments not configured or config invalid | `503` | none |
| invalid signature | `400` | **none** (M1 fix; previously set `paymentStatus=failed`) |
| already `paid` with the same payment id | `200 { ok: true, alreadyVerified: true }` | none |
| already paid with a different payment id, or order not `awaiting_payment` (e.g. `cancelled`) | `409` (logged for reconciliation) | none |
| `awaiting_payment` and `unpaid`/`failed`, valid signature | `200 { ok: true }` | conditional update → `paid`/`paid` + `razorpayPaymentId` |
| lost a concurrent race | `200 alreadyVerified` if same payment, else `409` | none |
Client (`CheckoutForm`) treats any non-2xx as "payment not completed" and shows the order page with `&payment=failed`.

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
| `PATCH /api/admin/orders/[id]` | `{ status?, paymentStatus? }` (enums) | `200 { ok }` · `404` · `422` for any value outside the enums (unchanged). **Any transition is allowed (M2-T2/T6 add a state machine).** |
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
