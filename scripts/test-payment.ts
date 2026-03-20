/**
 * Test script for the Razorpay API Worker
 *
 * Usage:
 *   1. Make sure your worker is running locally (npm run dev)
 *   2. Run: npx tsx scripts/test-payment.ts
 *
 * Override defaults via env vars:
 *   API_URL=https://razorpay-api.workers.dev RAZORPAY_SERVICE_SECRET=<secret> npx tsx scripts/test-payment.ts
 */

import { SignJWT } from 'jose';
import { SERVICE_ID } from '../src/constants.ts';

const API_URL = process.env.API_URL || 'http://127.0.0.1:9003';
const SERVICE_SECRET = process.env.RAZORPAY_SERVICE_SECRET || 'dev-service-secret-change-me';

async function getServiceJwt(): Promise<string> {
  if (process.env.SERVICE_JWT) return process.env.SERVICE_JWT;
  const secret = new TextEncoder().encode(SERVICE_SECRET);
  return new SignJWT({ service_id: SERVICE_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

let authHeaders: Record<string, string> = {};

function pass(label: string, detail?: string) {
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string) {
  console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\nSending GET /health...');
  const res = await fetch(`${API_URL}/health`);
  const data = await res.json() as any;

  if (res.ok && data.status === 'ok') {
    pass('Health check', `env=${data.environment}, version=${data.version}`);
  } else {
    fail('Health check', JSON.stringify(data));
  }
}

// ─── Auth Guard ───────────────────────────────────────────────────────────────

async function testAuthGuard() {
  console.log('\nSending POST /create-order without auth...');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 99900 }),
  });
  const data = await res.json() as any;

  res.status === 401
    ? pass('Auth guard — missing JWT returns 401', `code=${data.error?.code}`)
    : fail('Auth guard', `expected 401, got ${res.status}`);
}

// ─── Create Order ─────────────────────────────────────────────────────────────

async function testCreateOrder() {
  console.log('\nSending POST /create-order...');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      amount: 99900,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { source: 'test-script', env: 'local' },
    }),
  });
  const data = await res.json() as any;

  if (res.ok && data.success && data.order?.id) {
    pass('Create order', `order_id=${data.order.id}, amount=${data.order.amount}`);
  } else {
    fail('Create order', JSON.stringify(data));
  }
}

// ─── Create Order — validation errors ────────────────────────────────────────

async function testCreateOrderValidation() {
  console.log('\nSending POST /create-order with float amount...');
  const floatRes = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ amount: 99.5, currency: 'INR' }),
  });
  const floatData = await floatRes.json() as any;
  floatRes.status === 400
    ? pass('Float amount rejected', `code=${floatData.error?.code}`)
    : fail('Float amount should be rejected', `expected 400, got ${floatRes.status}`);

  console.log('\nSending POST /create-order with invalid receipt...');
  const rcptRes = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ amount: 99900, receipt: 'bad receipt!@#' }),
  });
  const rcptData = await rcptRes.json() as any;
  rcptRes.status === 400
    ? pass('Invalid receipt rejected', `code=${rcptData.error?.code}`)
    : fail('Invalid receipt should be rejected', `expected 400, got ${rcptRes.status}`);
}

// ─── Content-Type Validation ──────────────────────────────────────────────────

async function testContentType() {
  console.log('\nSending POST /create-order with wrong Content-Type...');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: {
      'Authorization': authHeaders['Authorization'],
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify({ amount: 99900 }),
  });
  const data = await res.json() as any;
  res.status === 415
    ? pass('Wrong Content-Type returns 415', `code=${data.error?.code}`)
    : fail('Content-Type validation', `expected 415, got ${res.status}`);
}

// ─── Method Not Allowed ───────────────────────────────────────────────────────

async function testMethodNotAllowed() {
  console.log('\nSending GET /create-order (wrong method)...');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'GET',
    headers: authHeaders,
  });
  const data = await res.json() as any;
  res.status === 405
    ? pass('Wrong method returns 405', `code=${data.error?.code}`)
    : fail('Method not allowed', `expected 405, got ${res.status}`);
}

// ─── Verify Payment ───────────────────────────────────────────────────────────

async function testVerifyPayment() {
  console.log('\nSending POST /verify-payment with invalid signature...');
  const res = await fetch(`${API_URL}/verify-payment`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      razorpay_order_id: 'order_test123',
      razorpay_payment_id: 'pay_test123',
      razorpay_signature: 'invalidsignature',
    }),
  });
  const data = await res.json() as any;
  res.status === 422 && !data.success
    ? pass('Invalid signature returns 422', `code=${data.error?.code}`)
    : fail('Verify payment', `expected 422, got ${res.status} — ${JSON.stringify(data)}`);
}

// ─── Verify Webhook ───────────────────────────────────────────────────────────

async function testVerifyWebhook() {
  console.log('\nSending POST /verify-webhook without signature header...');
  const noSig = await fetch(`${API_URL}/verify-webhook`, {
    method: 'POST',
    headers: { ...authHeaders },
    body: JSON.stringify({ event: 'payment.captured' }),
  });
  noSig.status === 400
    ? pass('Missing webhook signature returns 400')
    : fail('Webhook missing signature', `expected 400, got ${noSig.status}`);

  console.log('\nSending POST /verify-webhook with invalid signature...');
  const badSig = await fetch(`${API_URL}/verify-webhook`, {
    method: 'POST',
    headers: { ...authHeaders, 'x-razorpay-signature': 'invalidsignature' },
    body: JSON.stringify({ event: 'payment.captured' }),
  });
  badSig.status === 401
    ? pass('Invalid webhook signature returns 401')
    : fail('Webhook invalid signature', `expected 401, got ${badSig.status}`);

  console.log('\nSending POST /verify-webhook with malformed JSON...');
  const badJson = await fetch(`${API_URL}/verify-webhook`, {
    method: 'POST',
    headers: { ...authHeaders, 'x-razorpay-signature': 'somesig' },
    body: 'not-json',
  });
  badJson.status === 400
    ? pass('Malformed webhook body returns 400')
    : fail('Webhook malformed JSON', `expected 400, got ${badJson.status}`);
}

// ─── Get Payment ──────────────────────────────────────────────────────────────

async function testGetPayment() {
  console.log('\nSending GET /payment/pay_TestDummyId12345...');
  const res = await fetch(`${API_URL}/payment/pay_TestDummyId12345`, {
    headers: authHeaders,
  });
  const data = await res.json() as any;
  typeof data === 'object' && 'success' in data
    ? pass('Get payment responds with structured JSON', `status=${res.status}`)
    : fail('Get payment', JSON.stringify(data));

  console.log('\nSending GET /payment/invalid-id...');
  const badRes = await fetch(`${API_URL}/payment/invalid-id`, { headers: authHeaders });
  const badData = await badRes.json() as any;
  badRes.status === 400
    ? pass('Invalid payment ID returns 400', `code=${badData.error?.code}`)
    : fail('Invalid payment ID', `expected 400, got ${badRes.status}`);
}

// ─── Cancel Subscription ──────────────────────────────────────────────────────

async function testCancelSubscription() {
  console.log('\nSending POST /subscription/invalid-id/cancel...');
  const res = await fetch(`${API_URL}/subscription/invalid-id/cancel`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  const data = await res.json() as any;
  res.status === 400
    ? pass('Invalid subscription ID returns 400', `code=${data.error?.code}`)
    : fail('Invalid subscription ID', `expected 400, got ${res.status}`);
}

// ─── 404 Handler ──────────────────────────────────────────────────────────────

async function test404() {
  console.log('\nSending GET /nonexistent-route...');
  const res = await fetch(`${API_URL}/nonexistent-route`, { headers: authHeaders });
  const data = await res.json() as any;
  res.status === 404
    ? pass('Unknown route returns 404', `code=${data.error?.code}`)
    : fail('404 handler', `expected 404, got ${res.status}`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== Razorpay API Worker — Manual Test Script ===');
  console.log(`Target: ${API_URL}`);

  const jwt = await getServiceJwt();
  console.log(`Auth: signing with secret length=${SERVICE_SECRET.length}, service_id=${SERVICE_ID}`);
  authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwt}`,
  };

  try {
    await testHealth();
    await testAuthGuard();
    await testCreateOrder();
    await testCreateOrderValidation();
    await testContentType();
    await testMethodNotAllowed();
    await testVerifyPayment();
    await testVerifyWebhook();
    await testGetPayment();
    await testCancelSubscription();
    await test404();
  } catch (err) {
    console.error('\nUnexpected error during tests:', err);
    process.exit(1);
  }

  console.log('\n=== Done ===');
}

run();
