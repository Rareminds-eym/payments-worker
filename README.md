# razorpay-api

A shared Cloudflare Worker that handles all Razorpay payment operations. It sits between your application layer (Pages Functions, backend services) and the Razorpay API. No frontend ever calls this worker directly.

```
Browser
  └─▶ Your App (Pages Functions / Backend)
        │  signs JWT with RAZORPAY_SERVICE_SECRET
        └─▶ razorpay-api Worker  (this repo)
              └─▶ Razorpay API
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

---

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Razorpay account](https://razorpay.com) with API keys

---

## Local Development

**1. Install dependencies**

```bash
npm install
```

**2. Create your local secrets file**

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and fill in your real values:

```env
ENVIRONMENT=local
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
RAZORPAY_SERVICE_SECRET=any-long-random-string-for-local-dev
```

This file is gitignored — never commit it.

**3. Create the KV namespace (one-time setup)**

```bash
npm run kv:create
```

Copy the returned `id` and `preview_id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "paste-id-here"
preview_id = "paste-preview-id-here"
```

**4. Start the dev server**

```bash
npm run dev
```

Worker runs on `http://127.0.0.1:9003`.

**5. Run the test script**

```bash
npm test
```

---

## Connecting Your Application

This worker uses **service JWT authentication**. Any application that calls this worker must:

1. Share the same `RAZORPAY_SERVICE_SECRET`
2. Generate a signed JWT before each request
3. Send it as `Authorization: Bearer <jwt>`

### Generating a service JWT (Node.js / Pages Functions)

```typescript
import { SignJWT } from 'jose';

const secret = new TextEncoder().encode(process.env.RAZORPAY_SERVICE_SECRET);

const token = await new SignJWT({ service_id: 'functions-payment-service' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secret);
```

The `service_id` claim must be exactly `functions-payment-service` — the worker rejects any other value.

### Making a request

```typescript
const response = await fetch('https://razorpay-api.<your-subdomain>.workers.dev/create-order', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    amount: 99900,       // in paise — ₹999
    currency: 'INR',
    receipt: 'rcpt_001',
    notes: { userId: 'usr_123' },
  }),
});

const data = await response.json();
// data.order.id → pass to Razorpay Checkout on the frontend
```

### Cloudflare Pages Functions example

```typescript
// functions/api/payments/create-order.ts
import { SignJWT } from 'jose';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Generate service JWT
  const secret = new TextEncoder().encode(env.RAZORPAY_SERVICE_SECRET);
  const token = await new SignJWT({ service_id: 'functions-payment-service' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);

  // 2. Forward to worker
  const res = await fetch(`${env.RAZORPAY_WORKER_URL}/create-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: request.body,
  });

  // 3. Return worker response to browser
  return res;
};
```

Your Pages Functions environment needs:
- `RAZORPAY_SERVICE_SECRET` — same value as the worker
- `RAZORPAY_WORKER_URL` — the deployed worker URL
- `RAZORPAY_KEY_ID` — your Razorpay public key (for passing to frontend checkout)

---

## Environments

This is a single worker. `ENVIRONMENT` is a runtime variable — there is no separate worker per environment.

### Local

```bash
npm run dev
# Worker: http://127.0.0.1:9003
# Secrets: loaded from .dev.vars via --env-file
# Rate limiting: in-memory (no KV required)
```

### Development

```bash
# Set secrets first (one-time)
npx wrangler secret put RAZORPAY_SERVICE_SECRET --env development
npx wrangler secret put RAZORPAY_KEY_ID --env development
npx wrangler secret put RAZORPAY_KEY_SECRET --env development
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET --env development

# Deploy
npm run deploy:development
# Worker: https://razorpay-api-development.<subdomain>.workers.dev
# ENVIRONMENT=development (dev CORS origins active)
```

### Staging

```bash
# Set secrets first (one-time)
npx wrangler secret put RAZORPAY_SERVICE_SECRET --env staging
npx wrangler secret put RAZORPAY_KEY_ID --env staging
npx wrangler secret put RAZORPAY_KEY_SECRET --env staging
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET --env staging

# Deploy
npm run deploy:staging
# Worker: https://razorpay-api-staging.<subdomain>.workers.dev
# ENVIRONMENT=staging (dev CORS origins active)
```

### Production

```bash
# Set secrets first (one-time)
npx wrangler secret put RAZORPAY_SERVICE_SECRET
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET

# Verify
npm run secrets:list

# Deploy
npm run deploy
# Worker: https://razorpay-api.<subdomain>.workers.dev
# ENVIRONMENT=production (only skillpassport.rareminds.in allowed in CORS)
```

---

## API Reference

All endpoints except `/health` require `Authorization: Bearer <service-jwt>`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Basic health check |
| GET | `/health?deep=true` | Bearer JWT | Health + Razorpay connectivity ping |
| POST | `/create-order` | Bearer JWT | Create a Razorpay order |
| POST | `/verify-payment` | Bearer JWT | Verify HMAC payment signature |
| POST | `/verify-webhook` | Bearer JWT | Verify Razorpay webhook signature |
| GET | `/payment/:id` | Bearer JWT | Fetch payment details |
| POST | `/subscription/:id/cancel` | Bearer JWT | Cancel a subscription |

### POST /create-order

```json
// Request
{
  "amount": 99900,
  "currency": "INR",
  "receipt": "rcpt_001",
  "notes": { "userId": "usr_123" }
}

// Response 200
{
  "success": true,
  "order": {
    "id": "order_xxxxxxxxxxxx",
    "amount": 99900,
    "currency": "INR",
    "status": "created",
    ...
  }
}
```

### POST /verify-payment

```json
// Request
{
  "razorpay_order_id": "order_xxxxxxxxxxxx",
  "razorpay_payment_id": "pay_xxxxxxxxxxxx",
  "razorpay_signature": "hmac_hex_string"
}

// Response 200 — valid signature
{ "success": true, "verified": true, "message": "Payment signature verified" }

// Response 422 — invalid signature
{ "success": false, "error": { "code": "UNAUTHORIZED", ... } }
```

### POST /verify-webhook

```
x-razorpay-signature: <hmac-sha256-hex>
Content-Type: application/json

<razorpay webhook payload>
```

```json
// Response 200
{ "success": true, "verified": true, "payload": { ...webhookEvent } }

// Response 401 — invalid signature (Razorpay will retry)
{ "success": false, "error": { "code": "UNAUTHORIZED", ... } }
```

### GET /payment/:id

```
// Response 200
{ "success": true, "payment": { "id": "pay_xxx", "amount": 99900, "status": "captured", ... } }
```

### POST /subscription/:id/cancel

```
// Response 200
{ "success": true, "subscription": { "id": "sub_xxx", "status": "cancelled", ... } }
```

### Error response shape

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid amount",
    "details": "Amount must be a positive integer in paise"
  },
  "timestamp": "2026-03-20T07:00:00.000Z",
  "request_id": "uuid"
}
```

Error codes: `UNAUTHORIZED`, `INVALID_INPUT`, `RATE_LIMIT_EXCEEDED`, `RAZORPAY_API_ERROR`, `INTERNAL_ERROR`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`

---

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `RAZORPAY_SERVICE_SECRET` | Yes | Shared HS256 secret for service JWT signing/verification |
| `RAZORPAY_KEY_ID` | Yes | Razorpay Key ID (`rzp_test_*` or `rzp_live_*`) |
| `RAZORPAY_KEY_SECRET` | Yes | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Conditional | Required when using `POST /verify-webhook` |
| `ENVIRONMENT` | Yes | `local` \| `development` \| `staging` \| `production` |
| `RATE_LIMIT_KV` | No | KV namespace for distributed rate limiting; falls back to in-memory if unbound |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server on port 9003 |
| `npm run deploy` | Deploy to production |
| `npm run deploy:development` | Deploy to development env |
| `npm run deploy:staging` | Deploy to staging env |
| `npm run tail` | Stream live logs from deployed worker |
| `npm run secrets:list` | List vaulted secrets |
| `npm run secrets:setup` | Run interactive secrets setup script |
| `npm run kv:create` | Create the RATE_LIMIT_KV namespace |
| `npm test` | Run test script against local worker |
| `npm run type-check` | TypeScript type check |
| `npm run lint` | Lint source files |

---

## Security Notes

- `.dev.vars` is gitignored — never commit it
- The frontend never calls this worker — all calls go through your application layer
- Service JWTs are short-lived HS256 tokens verified on every request
- `RAZORPAY_KEY_ID` is not returned in API responses — your application layer holds it for frontend checkout
- HMAC signatures use `crypto.subtle` with constant-time comparison to prevent timing attacks
- Razorpay IDs are regex-validated before use in outbound URLs (SSRF prevention)
- Webhook bodies are size-limited to 512KB before reading (DoS prevention)
- `?deep=true` health check requires auth to prevent unauthenticated outbound Razorpay calls
- localhost origins are blocked in production CORS
