# razorpay-api

Cloudflare Worker that acts as a shared Razorpay payment processing layer. It sits between your Pages Functions (business logic) and the Razorpay API — no frontend ever calls it directly.

```
Browser → Pages Functions (/api/payments/*) → razorpay-api Worker → Razorpay API
```

---

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Razorpay account](https://razorpay.com) with API keys

---

## Local Setup

**1. Install dependencies**

```bash
npm install
```

**2. Create your local secrets file**

Copy the example below into a new `.dev.vars` file at the project root. This file is gitignored — never commit it.

```ini
# .dev.vars

# API keys used by Pages Functions to authenticate with this worker
SKILLPASSPORT_API_KEY_LOCAL=
SKILLPASSPORT_API_KEY_DEV=
SKILLPASSPORT_API_KEY_STAGING=
SKILLPASSPORT_API_KEY_PROD=
LEGACY_API_KEY=

# Razorpay test keys (get these from your Razorpay dashboard)
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXXXX
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Environment
ENVIRONMENT=local
RAZORPAY_MODE=test
```

**3. Start the dev server**

```bash
npm run dev
```

The worker runs on `http://localhost:9003` by default (configured in `wrangler.toml`).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SKILLPASSPORT_API_KEY_LOCAL` | Local only | API key for local callers |
| `SKILLPASSPORT_API_KEY_DEV` | Dev/Staging | API key for development callers |
| `SKILLPASSPORT_API_KEY_STAGING` | Staging | API key for staging callers |
| `SKILLPASSPORT_API_KEY_PROD` | Production | API key for production callers |
| `LEGACY_API_KEY` | No | Backward-compat key for older integrations |
| `RAZORPAY_KEY_ID` | Yes | Razorpay Key ID (`rzp_test_*` or `rzp_live_*`) |
| `RAZORPAY_KEY_SECRET` | Yes | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | No | Required only if using `/verify-webhook` |
| `ENVIRONMENT` | Yes | `local`, `development`, `staging`, or `production` |
| `RAZORPAY_MODE` | No | `test` or `live` — overrides ENVIRONMENT default |

---

## API Endpoints

All endpoints (except `/health`) require the `X-API-Key` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Health check |
| POST | `/create-order` | X-API-Key | Create a Razorpay order |
| POST | `/verify-payment` | X-API-Key | Verify HMAC payment signature |
| POST | `/verify-webhook` | X-API-Key | Verify Razorpay webhook signature |
| GET | `/payment/:id` | X-API-Key | Fetch payment details |
| POST | `/subscription/:id/cancel` | X-API-Key | Cancel a subscription |

### Example: Create Order

```bash
curl -X POST http://localhost:9003/create-order \
  -H "Content-Type: application/json" \
  -H "X-API-Key: local-key-skillpassport-12345" \
  -d '{"amount": 99900, "currency": "INR", "receipt": "rcpt_001"}'
```

---

## Running Per Environment

### Local

Uses `.dev.vars` automatically. Razorpay test keys, no deployment.

```bash
wrangler dev --port=9003
```

### Development

```bash
# First time — set secrets
wrangler secret put RAZORPAY_KEY_ID --env development
wrangler secret put RAZORPAY_KEY_SECRET --env development
wrangler secret put RAZORPAY_WEBHOOK_SECRET --env development
wrangler secret put SKILLPASSPORT_API_KEY_DEV --env development
wrangler secret put SKILLPASSPORT_API_KEY_PROD --env development

# Deploy
wrangler deploy --env development
```

Deploys as `razorpay-api-development`. Uses `rzp_test_*` keys, `ENVIRONMENT=development`.

### Staging

```bash
# First time — set secrets
wrangler secret put RAZORPAY_KEY_ID --env staging
wrangler secret put RAZORPAY_KEY_SECRET --env staging
wrangler secret put RAZORPAY_WEBHOOK_SECRET --env staging
wrangler secret put SKILLPASSPORT_API_KEY_STAGING --env staging
wrangler secret put SKILLPASSPORT_API_KEY_PROD --env staging

# Deploy
wrangler deploy --env staging
```

Deploys as `razorpay-api-staging`. Uses `rzp_test_*` keys, `ENVIRONMENT=staging`.

### Production

```bash
# First time — set secrets (use rzp_live_* keys here)
wrangler secret put RAZORPAY_KEY_ID --env production
wrangler secret put RAZORPAY_KEY_SECRET --env production
wrangler secret put RAZORPAY_WEBHOOK_SECRET --env production
wrangler secret put SKILLPASSPORT_API_KEY_PROD --env production

# Deploy
wrangler deploy --env production
```

Deploys as `razorpay-api-production`. Uses `rzp_live_*` keys, `RAZORPAY_MODE=live`, `ENVIRONMENT=production`.

---

## Deployment

```bash
# Deploy to specific environment
npm run deploy                        # production (default)
wrangler deploy --env development
wrangler deploy --env staging
wrangler deploy --env production
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server on port 9003 |
| `npm run deploy` | Deploy to Cloudflare (production) |
| `npm run type-check` | Run TypeScript type checking |
| `npm run lint` | Lint source files |

---

## Security Notes

- `.dev.vars` is gitignored — keep your secrets out of version control
- The `X-API-Key` is only held server-side (Pages Functions / Worker secrets), never in the browser
- Razorpay HMAC signatures are always verified before any order is trusted
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full security model

---

## Project Structure

```
src/
├── index.ts              # Main entry point
├── types.ts              # TypeScript types
├── constants.ts          # Configuration constants
├── middleware/
│   ├── auth.ts          # API key authentication
│   ├── rateLimit.ts     # Rate limiting
│   └── logger.ts        # Structured logging
├── routes/
│   ├── health.ts        # Health check
│   ├── orders.ts        # Order creation
│   └── payments.ts      # Payment operations
├── helpers/
│   ├── razorpay.ts      # Razorpay credential helpers
│   └── supabase.ts      # Supabase client helpers
└── utils/
    ├── response.ts      # Response helpers
    └── fetch.ts         # Fetch with timeout/retry
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `UNAUTHORIZED` | Missing or invalid API key |
| `INVALID_INPUT` | Invalid request parameters |
| `RATE_LIMIT_EXCEEDED` | Too many requests |
| `RAZORPAY_API_ERROR` | Razorpay API error |
| `INTERNAL_ERROR` | Internal server error |
| `NOT_FOUND` | Endpoint not found |
| `TIMEOUT` | Request timeout |

---

**Version:** 2.0.0
