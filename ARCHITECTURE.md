# Razorpay Payment System — Architecture & Implementation

## Overview

The payment system is split into two layers:

```
Browser (Frontend)
    ↓  Bearer JWT (Supabase token)
Pages Functions  /api/payments/*   ← business logic layer
    ↓  X-API-Key (server-to-server)
razorpay-api Worker  :9003         ← pure Razorpay infrastructure
    ↓  Basic Auth
Razorpay API
```

The frontend never calls the razorpay-api worker directly. All calls go through the Pages Functions layer which holds the API key securely.

---

## Layer 1 — razorpay-api Worker (`cloudflare-workers/razorpay-api`)

Pure Razorpay infrastructure. No business logic, no Supabase writes.

**Port (local dev):** `9003`  
**Auth:** `X-API-Key` header required on every request

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — no auth required |
| POST | `/create-order` | Create a Razorpay order |
| POST | `/verify-payment` | Verify HMAC signature |
| POST | `/verify-webhook` | Verify Razorpay webhook signature |
| GET | `/payment/:id` | Fetch payment details from Razorpay |
| POST | `/subscription/:id/cancel` | Cancel a Razorpay subscription |

### Request/Response shapes

**POST /create-order**
```json
// Request
{ "amount": 99900, "currency": "INR", "receipt": "rcpt_...", "notes": {} }

// Response
{ "success": true, "order": { "id": "order_xxx", "amount": 99900, ... }, "key_id": "rzp_test_..." }
```

**POST /verify-payment**
```json
// Request
{ "razorpay_order_id": "order_xxx", "razorpay_payment_id": "pay_xxx", "razorpay_signature": "..." }

// Response
{ "success": true, "verified": true, "message": "Payment signature verified" }
```

### Middleware stack
- `auth.ts` — validates `X-API-Key` against `SKILLPASSPORT_API_KEY_DEV` / `SKILLPASSPORT_API_KEY_PROD`
- `logger.ts` — structured request/response logging with request IDs
- `rateLimit.ts` — per-website rate limiting per endpoint

### Environment variables (`cloudflare-workers/razorpay-api/.dev.vars`)
```
SKILLPASSPORT_API_KEY_DEV=dev-key-skillpassport-12345
SKILLPASSPORT_API_KEY_PROD=prod-key-skillpassport-12345
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
ENVIRONMENT=development
```

---

## Layer 2 — Pages Functions (`functions/api/payments/[[path]].ts`)

Business logic layer. Authenticates users via Supabase JWT, runs DB operations, calls the razorpay-api worker server-to-server.

**Base path:** `/api/payments/*`  
**Auth:** `Authorization: Bearer <supabase_jwt>` for user routes

### All Endpoints

#### Public (no auth)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/payments/plans` | `plans.ts` | All subscription plans |
| GET | `/api/payments/plan` | `plans.ts` | Single plan by `?planCode=` |
| GET | `/api/payments/features` | `plans.ts` | Feature comparison matrix |
| GET | `/api/payments/addon-catalog` | `addons.ts` | Add-on & bundle catalog |

#### User auth required (Bearer JWT)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/payments/create-order` | `subscriptions.ts` | Create Razorpay order for subscription |
| POST | `/api/payments/verify-payment` | `subscriptions.ts` | Verify payment + create subscription record |
| GET | `/api/payments/get-subscription` | `subscriptions.ts` | Get user's active subscription |
| GET | `/api/payments/check-subscription-access` | `subscriptions.ts` | Check access + days until expiry |
| POST | `/api/payments/cancel-subscription` | `subscriptions.ts` | Cancel subscription |
| POST | `/api/payments/deactivate-subscription` | `subscriptions.ts` | Deactivate with reason |
| POST | `/api/payments/pause-subscription` | `subscriptions.ts` | Pause for N months |
| POST | `/api/payments/resume-subscription` | `subscriptions.ts` | Resume paused subscription |
| GET | `/api/payments/user-entitlements` | `addons.ts` | User's active add-on entitlements |
| GET | `/api/payments/check-addon-access` | `addons.ts` | Check feature access by key |
| POST | `/api/payments/create-addon-order` | `addons.ts` | Create order for add-on purchase |
| POST | `/api/payments/verify-addon-payment` | `addons.ts` | Verify + activate add-on entitlement |
| POST | `/api/payments/cancel-addon` | `addons.ts` | Cancel add-on (access until end date) |
| POST | `/api/payments/create-bundle-order` | `addons.ts` | Create order for bundle purchase |
| POST | `/api/payments/verify-bundle-payment` | `addons.ts` | Verify + activate all bundle features |

#### Internal / Cron (`X-Cron-Secret` header required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/payments/expire-entitlements` | `entitlements.ts` | Mark expired entitlements |
| POST | `/api/payments/send-renewal-reminders` | `entitlements.ts` | Send 7/3/1 day reminder emails |
| POST | `/api/payments/process-auto-renewals` | `entitlements.ts` | Process auto-renewals |
| POST | `/api/payments/process-entitlement-lifecycle` | `entitlements.ts` | Run all lifecycle tasks |

### Handler files

| File | Responsibility |
|------|---------------|
| `handlers/subscriptions.ts` | Core subscription CRUD — create order, verify payment, get/cancel/pause/resume subscription |
| `handlers/plans.ts` | Read-only plan data from `subscription_plans` table |
| `handlers/addons.ts` | Add-on and bundle purchase, entitlement management |
| `handlers/entitlements.ts` | Cron lifecycle — expiry, reminders, auto-renewal |

### `create-order` flow
1. Authenticate user via Supabase JWT
2. Check for existing active subscription (block if exists, unless `isUpgrade=true`)
3. Rate limit: max 5 orders per minute per user
4. Call `razorpay-api /create-order` with `X-API-Key`
5. Save order to `razorpay_orders` table
6. Return `{ id, amount, currency, key }` to frontend

### `verify-payment` flow
1. Authenticate user
2. Idempotency check — if payment already processed, return existing subscription
3. Look up order in `razorpay_orders`
4. Call `razorpay-api /verify-payment` to validate HMAC signature
5. Handle renewal (same plan) or upgrade (different plan — cancel old, create new)
6. Resolve `plan_id` UUID from `subscription_plans` by `plan_code`
7. Insert into `subscriptions` table with `status: active`, 1-year end date
8. Insert into `payment_transactions` table
9. Update `razorpay_orders` with payment ID and subscription ID

---

## Layer 3 — Frontend Services

### `src/services/paymentsApiService.js`
HTTP client. All calls go to `/api/payments/*` (Pages Functions). Sends `Authorization: Bearer <token>`.

### `src/services/Subscriptions/razorpayService.js`
Browser-only. Loads Razorpay checkout.js SDK, opens the payment modal, handles success/failure redirects.

### `src/hooks/Subscription/useSubscriptionPlansData.js`
React hook. Fetches plans from `/api/payments/plans`, `/api/payments/plan`, `/api/payments/features`.

### `src/services/addOnPaymentService.js`
Calls `/api/payments/create-addon-order`, `/api/payments/verify-addon-payment`, etc.

---

## Database Tables Used

| Table | Purpose |
|-------|---------|
| `subscription_plans` | Plan definitions (plan_code, price, features) |
| `subscription_plan_features` | Feature matrix per plan, add-on pricing |
| `subscriptions` | User subscription records |
| `razorpay_orders` | Order tracking (created → paid) |
| `payment_transactions` | Payment audit log |
| `user_entitlements` | Active add-on/bundle entitlements per user |
| `addon_pending_orders` | Pending add-on orders before payment |
| `bundles` | Bundle definitions |
| `bundle_features` | Features included in each bundle |

---

## Local Development

```
# Terminal 1 — razorpay-api worker (port 9003)
npm run workers:payments

# Terminal 2 — Pages Functions + frontend (port 8788)
npm run build:dev && npm run pages:dev
```

### Key env vars (`.dev.vars` root)
```
RAZORPAY_WORKER_URL=http://localhost:9003
RAZORPAY_WORKER_API_KEY=dev-key-skillpassport-12345
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=...
```

### Key env vars (`cloudflare-workers/razorpay-api/.dev.vars`)
```
SKILLPASSPORT_API_KEY_DEV=dev-key-skillpassport-12345
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
```

---

## Security Model

- Frontend never holds the `X-API-Key` — it only has the Supabase JWT
- The `X-API-Key` lives only in `.dev.vars` (local) and Cloudflare Worker secrets (production)
- Supabase JWT is validated server-side in the Pages Functions layer via `authenticateRequest()`
- Cron routes require a separate `X-Cron-Secret` header
- Razorpay HMAC signature is always verified before any subscription is created
