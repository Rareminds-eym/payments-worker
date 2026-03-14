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
SKILLPASSPORT_API_KEY_PROD=
SKILLPASSPORT_API_KEY_DEV=
LEGACY_API_KEY=

# Razorpay test keys (get these from your Razorpay dashboard)
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXXXX
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Environment
ENVIRONMENT=development
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
| `SKILLPASSPORT_API_KEY_PROD` | Yes | API key for production callers |
| `SKILLPASSPORT_API_KEY_DEV` | Yes | API key for dev/staging callers |
| `LEGACY_API_KEY` | No | Backward-compat key for older integrations |
| `RAZORPAY_KEY_ID` | Yes | Razorpay Key ID (test or live) |
| `RAZORPAY_KEY_SECRET` | Yes | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | No | Required only if using `/verify-webhook` |
| `ENVIRONMENT` | Yes | `development` or `production` |

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
  -H "X-API-Key: dev-key-skillpassport-12345" \
  -d '{"amount": 99900, "currency": "INR", "receipt": "rcpt_001"}'
```

---

## Deployment

**1. Set production secrets via Wrangler**

```bash
wrangler secret put RAZORPAY_KEY_ID
wrangler secret put RAZORPAY_KEY_SECRET
wrangler secret put RAZORPAY_WEBHOOK_SECRET
wrangler secret put SKILLPASSPORT_API_KEY_PROD
wrangler secret put SKILLPASSPORT_API_KEY_DEV
```

**2. Deploy**

```bash
npm run deploy
```

To deploy to the test environment:

```bash
wrangler deploy --env test
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run type-check` | Run TypeScript type checking |
| `npm run lint` | Lint source files |

---

## Security Notes

- `.dev.vars` is gitignored — keep your secrets out of version control
- The `X-API-Key` is only held server-side (Pages Functions / Worker secrets), never in the browser
- Razorpay HMAC signatures are always verified before any order is trusted
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full security model
