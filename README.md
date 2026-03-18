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

## Local Development

**1. Install dependencies**

```bash
npm install
```

**2. Create your local secrets file**

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your local credentials. This file is gitignored — never commit it.

**3. Start the dev server**

```bash
npm run dev
```

The worker runs on `http://localhost:9003` by default.

---

## Deployment

This is a single unified worker instance. All environments share the same deployment — `ENVIRONMENT` is a runtime var, not a separate worker.

**1. Configure secrets (first time only)**

Set them individually using Wrangler:

```bash
npx wrangler secret put SKILLPASSPORT_API_KEY_PROD
npx wrangler secret put SKILLPASSPORT_API_KEY_DEV
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
```

Verify what's vaulted:

```bash
npm run secrets:list
```

**2. Deploy**

```bash
npm run deploy
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SKILLPASSPORT_API_KEY_PROD` | Yes | API key for production callers |
| `SKILLPASSPORT_API_KEY_DEV` | Yes | API key for dev/staging callers |
| `RAZORPAY_KEY_ID` | Yes | Razorpay Key ID (`rzp_test_*` or `rzp_live_*`) |
| `RAZORPAY_KEY_SECRET` | Yes | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | No | Required only if using `/verify-webhook` |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `ENVIRONMENT` | Yes | Set in `wrangler.toml` as `production`; overridden to `development` via `.dev.vars` locally |

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
  -H "X-API-Key: dev-key-skillpassport-xxxxx" \
  -d '{"amount": 99900, "currency": "INR", "receipt": "rcpt_001"}'
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run tail` | Stream live logs from the deployed worker |
| `npm run secrets:list` | List currently vaulted secrets |
| `npm run type-check` | TypeScript type checking |
| `npm run lint` | Lint source files |

---

## Security Notes

- `.dev.vars` is gitignored — keep your secrets out of version control
- The `X-API-Key` is only held server-side (Pages Functions / Worker secrets), never in the browser
- Razorpay HMAC signatures are always verified before any order is trusted
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full security model
