# razorpay-api — Architecture

## Overview

`razorpay-api` is a Cloudflare Worker that acts as a shared Razorpay payment processing layer. It sits between the Pages Functions layer (business logic) and the Razorpay API. The frontend never calls this worker directly.

```
Browser
  │
  ▼
Cloudflare Pages (skillpassport.rareminds.in)
  │  Pages Functions (/api/payments/*)
  │  - Holds business logic
  │  - Signs service JWT with RAZORPAY_SERVICE_SECRET
  │  - Provides RAZORPAY_KEY_ID to frontend for checkout
  │
  ▼  Authorization: Bearer <service-jwt>
razorpay-api Worker (this repo)
  │  - Verifies service JWT
  │  - Validates input
  │  - Rate limits per caller
  │  - Calls Razorpay API
  │
  ▼  Basic Auth (RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET)
Razorpay API (api.razorpay.com/v1)
```

---

## Request Lifecycle

Every request goes through this pipeline in `src/index.ts`:

```
Incoming Request
  │
  ├─ OPTIONS → CORS preflight (204, no auth)
  │
  ├─ GET /health → Health check (no auth)
  │    └─ GET /health?deep=true → Razorpay connectivity ping (requires auth)
  │
  ├─ authenticateRequest() → verify service JWT
  │    └─ 401 if missing, malformed, expired, or wrong service_id
  │
  ├─ checkRateLimit() → per-caller, per-endpoint window
  │    └─ 429 + Retry-After if exceeded
  │
  ├─ Route handler (validate → call Razorpay → respond)
  │
  └─ attachRateLimitHeaders() → inject X-RateLimit-* on every response
```

---

## Authentication

All endpoints except `GET /health` require a service JWT in the `Authorization` header:

```
Authorization: Bearer <service-jwt>
```

The JWT is:
- Signed with `RAZORPAY_SERVICE_SECRET` using HS256
- Must contain `service_id: "functions-payment-service"` (constant in `src/constants.ts`)
- Verified in `src/middleware/auth.ts` using `jose.jwtVerify`

The Pages Functions layer generates this JWT before calling the worker. No browser-originated request ever reaches this worker directly.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Basic health check |
| GET | `/health?deep=true` | Bearer JWT | Health + Razorpay connectivity ping |
| POST | `/create-order` | Bearer JWT | Create a Razorpay order |
| POST | `/verify-payment` | Bearer JWT | Verify HMAC payment signature |
| POST | `/verify-webhook` | Bearer JWT | Verify Razorpay webhook HMAC signature |
| GET | `/payment/:id` | Bearer JWT | Fetch payment details from Razorpay |
| POST | `/subscription/:id/cancel` | Bearer JWT | Cancel a Razorpay subscription |

### Response shape — success

```json
{ "success": true, ...data }
```

### Response shape — error

```json
{
  "success": false,
  "error": { "code": "ERROR_CODE", "message": "...", "details": "..." },
  "timestamp": "2026-03-20T07:00:00.000Z",
  "request_id": "uuid"
}
```

All responses include `X-Request-ID` and `X-RateLimit-*` headers (except preflight and unauthenticated errors).

---

## Source Layout

```
src/
  index.ts              — Entry point: routing, auth pipeline, rate limit header injection
  types.ts              — All TypeScript interfaces (Env, request/response shapes, log types)
  constants.ts          — All magic values: limits, timeouts, CORS origins, error codes, SERVICE_ID

  middleware/
    auth.ts             — JWT verification (jose), returns AuthResult or 401 Response
    rateLimit.ts        — Per-caller/endpoint sliding window; KV in production, in-memory locally
    logger.ts           — Structured JSON logger (error/warn/info), writes to console

  routes/
    health.ts           — GET /health, optional deep Razorpay ping
    orders.ts           — POST /create-order with full input validation
    payments.ts         — POST /verify-payment, POST /verify-webhook, GET /payment/:id,
                          POST /subscription/:id/cancel

  utils/
    response.ts         — jsonResponse, errorResponse (options-object only), corsPreflightResponse,
                          timingSafeEqual, requireJsonContentType
    fetch.ts            — fetchWithTimeout (AbortController), fetchWithRetry (exponential backoff)
```

---

## Rate Limiting

Implemented in `src/middleware/rateLimit.ts`. Limits are per `callerId` (from JWT `service_id`) per endpoint per 60-second window.

| Endpoint | Limit / minute |
|----------|:--------------:|
| `create-order` | 20 |
| `verify-payment` | 30 |
| `get-payment` | 50 |
| `cancel-subscription` | 10 |
| `verify-webhook` | 100 |

**KV path (production):** Uses `RATE_LIMIT_KV` namespace. Key format: `rl:{callerId}:{endpoint}`. TTL auto-expires via `expirationTtl`.

**In-memory path (local dev):** Falls back to a module-level `Map` when `RATE_LIMIT_KV` is not bound. Pruned when `size > 1000`. Not distributed — resets on isolate restart.

**Known limitation:** The KV path is not atomic (TOCTOU). Two concurrent requests can both read the same count and both write `count+1`. Acceptable for low-to-moderate concurrency. For strict atomicity, migrate to Durable Objects.

Every response includes:
```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 2026-03-20T07:01:00.000Z
```

429 responses also include `Retry-After: <seconds>`.

---

## Input Validation

All POST handlers validate before calling Razorpay:

**`/create-order`**
- `amount`: positive integer in paise, between 100 (₹1) and 10,000,000 (₹1 lakh)
- `currency`: only `INR` accepted
- `receipt`: max 40 chars, alphanumeric/underscore/hyphen only (`/^[a-zA-Z0-9_-]{1,40}$/`)
- `notes`: max 15 key-value pairs, keys ≤ 40 chars, values ≤ 256 chars

**`/verify-payment`**
- All three fields (`razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`) required
- HMAC-SHA256 verified using `RAZORPAY_KEY_SECRET` via `crypto.subtle`
- Constant-time comparison via `timingSafeEqual` to prevent timing attacks
- Returns 422 (not 200 with `verified: false`) on signature mismatch

**`/verify-webhook`**
- `x-razorpay-signature` header required
- Body size limited to 512KB (pre-check via `Content-Length`, post-check via `body.length`)
- JSON parsed before crypto block — malformed body returns 400, not 500
- HMAC-SHA256 verified using `RAZORPAY_WEBHOOK_SECRET`
- Returns 401 on mismatch so Razorpay retries the webhook

**`/payment/:id`**
- Payment ID validated against `/^pay_[A-Za-z0-9]{14,}$/` before use in URL

**`/subscription/:id/cancel`**
- Subscription ID validated against `/^sub_[A-Za-z0-9]{14,}$/` before use in URL
- No retries — cancellation must not be retried on failure

---

## CORS

Managed in `src/utils/response.ts`. Origin allowlist is environment-aware:

**Production** (`ENVIRONMENT=production`):
- `https://skillpassport.rareminds.in`
- `https://www.skillpassport.rareminds.in`

**Non-production** (local, development, staging):
- All production origins plus `localhost:8788`, `localhost:5173`, `127.0.0.1:8788`, `127.0.0.1:5173`

Requests from unlisted origins receive no `Access-Control-Allow-Origin` header (browser blocks them). `Vary: Origin` is always set. `Access-Control-Max-Age: 3600`.

---

## Logging

Structured JSON via `src/middleware/logger.ts`. Every log entry includes:

```json
{
  "level": "info",
  "message": "Request received",
  "timestamp": "2026-03-20T07:00:00.000Z",
  "requestId": "uuid",
  "callerId": "functions-payment-service",
  "meta": { "method": "POST", "path": "/create-order" }
}
```

Levels: `error`, `warn`, `info`. Written to `console.error` / `console.warn` / `console.log` — captured by Cloudflare's observability pipeline (`[observability] enabled = true` in `wrangler.toml`).

---

## Outbound Fetch

`src/utils/fetch.ts` wraps all Razorpay API calls:

- `fetchWithTimeout`: AbortController-based, default 10s timeout
- `fetchWithRetry`: exponential backoff (1s, 2s) on 5xx, max 2 retries
  - 4xx responses are returned immediately without retry
  - Subscription cancellation uses 0 retries
  - Max backoff: ~3s = ~10% of the 30s Worker CPU budget

All Razorpay calls use HTTP Basic Auth: `btoa(RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET)`.

Create order requests include an `Idempotency-Key` header (set to `requestId`) to prevent duplicate orders on retry.

---

## Environment Variables

| Variable | Required | Where set | Description |
|----------|:--------:|-----------|-------------|
| `RAZORPAY_SERVICE_SECRET` | Yes | `wrangler secret put` / `.dev.vars` | Shared HS256 secret for service JWT signing/verification |
| `RAZORPAY_KEY_ID` | Yes | `wrangler secret put` / `.dev.vars` | Razorpay API Key ID (`rzp_test_*` or `rzp_live_*`) |
| `RAZORPAY_KEY_SECRET` | Yes | `wrangler secret put` / `.dev.vars` | Razorpay API Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Conditional | `wrangler secret put` / `.dev.vars` | Required when using `POST /verify-webhook` |
| `ENVIRONMENT` | Yes | `wrangler.toml [vars]` / `.dev.vars` | `local` \| `development` \| `staging` \| `production` |
| `RATE_LIMIT_KV` | No | `wrangler.toml [[kv_namespaces]]` | KV namespace for distributed rate limiting; falls back to in-memory if unbound |
| `EMAIL_SERVICE` | No | Service binding | Optional bound email worker |

---

## Deployment

Single worker, `ENVIRONMENT` is a runtime variable — not a separate worker per environment.

```bash
npm run deploy                   # production (ENVIRONMENT=production)
npm run deploy:development       # development env (ENVIRONMENT=development)
npm run deploy:staging           # staging env (ENVIRONMENT=staging)
```

Local dev:
```bash
npm run dev    # wrangler dev --port 9003 --env-file .dev.vars
```

---

## Security Properties

- Frontend never calls this worker — all calls go through Pages Functions
- Service JWTs are short-lived HS256 tokens, verified on every request
- `service_id` claim is validated against the hardcoded constant `functions-payment-service`
- HMAC signatures use `crypto.subtle` (Web Crypto API) — no third-party crypto
- Signature comparisons use constant-time `timingSafeEqual` to prevent timing attacks
- Razorpay IDs are regex-validated before use in outbound URLs (SSRF prevention)
- Webhook body is size-limited before reading (DoS prevention)
- CORS allowlist is environment-aware — localhost origins blocked in production
- No secrets are logged or returned in responses
- `RAZORPAY_KEY_ID` is not included in API responses — Pages Functions hold their own copy for frontend checkout initialization
