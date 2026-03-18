/**
 * Test script for the Razorpay API Worker
 *
 * Usage:
 *   1. Make sure your worker is running locally (npm run dev)
 *   2. Run: npx tsx scripts/test-payment.ts
 *
 * Override defaults via env vars:
 *   API_URL=https://razorpay-api.workers.dev API_KEY=your_key npx tsx scripts/test-payment.ts
 */

const API_URL = process.env.API_URL || 'http://localhost:9003';
const API_KEY = process.env.API_KEY || 'dev-key-skillpassport-xxxxx'; // Replace with your dev key

const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
};

let createdOrderId = '';
let testsPassed = 0;
let testsFailed = 0;

function pass(label: string, detail?: string) {
  testsPassed++;
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string) {
  testsFailed++;
  console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

// ─── Health Check ────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n── Health Check ──────────────────────────────');
  const res = await fetch(`${API_URL}/health`);
  const data = await res.json() as any;

  res.ok && data.status === 'ok'
    ? pass('Health check', `env=${data.environment}`)
    : fail('Health check', JSON.stringify(data));
}

// ─── Create Order ────────────────────────────────────────────────────────────

async function testCreateOrder() {
  console.log('\n── Create Order ──────────────────────────────');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 99900,       // ₹999 in paise
      currency: 'INR',
      receipt: `test_rcpt_${Date.now()}`,
      notes: { source: 'test-script' },
    }),
  });

  const data = await res.json() as any;

  if (res.ok && data.success && data.order?.id) {
    createdOrderId = data.order.id;
    pass('Create order', `order_id=${createdOrderId}, amount=${data.order.amount}`);
  } else {
    fail('Create order', JSON.stringify(data));
  }
}

// ─── Verify Payment (with dummy values — expects verified: false) ─────────────

async function testVerifyPayment() {
  console.log('\n── Verify Payment ────────────────────────────');
  const res = await fetch(`${API_URL}/verify-payment`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      razorpay_order_id: createdOrderId || 'order_test123',
      razorpay_payment_id: 'pay_test123',
      razorpay_signature: 'invalidsignature',
    }),
  });

  const data = await res.json() as any;

  // Signature will be invalid — we just want a valid response shape
  res.ok && data.success && typeof data.verified === 'boolean'
    ? pass('Verify payment', `verified=${data.verified} (expected false for dummy sig)`)
    : fail('Verify payment', JSON.stringify(data));
}

// ─── Get Payment ─────────────────────────────────────────────────────────────

async function testGetPayment() {
  console.log('\n── Get Payment ───────────────────────────────');
  // Use a dummy ID — Razorpay will return 400/404, we just verify the worker handles it
  const res = await fetch(`${API_URL}/payment/pay_testDummyId`, { headers });
  const data = await res.json() as any;

  // Worker should return a structured error, not crash
  typeof data === 'object' && 'success' in data
    ? pass('Get payment (error handling)', `status=${res.status}`)
    : fail('Get payment', JSON.stringify(data));
}

// ─── Auth Guard ───────────────────────────────────────────────────────────────

async function testAuthGuard() {
  console.log('\n── Auth Guard ────────────────────────────────');
  const res = await fetch(`${API_URL}/create-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // no X-API-Key
    body: JSON.stringify({ amount: 100 }),
  });

  const data = await res.json() as any;

  res.status === 401
    ? pass('Auth guard blocks missing key', `code=${data.error?.code}`)
    : fail('Auth guard', `expected 401, got ${res.status}`);
}

// ─── 404 Handler ─────────────────────────────────────────────────────────────

async function test404() {
  console.log('\n── 404 Handler ───────────────────────────────');
  const res = await fetch(`${API_URL}/nonexistent-route`, { headers });
  const data = await res.json() as any;

  res.status === 404
    ? pass('404 handler', data.error?.code)
    : fail('404 handler', `expected 404, got ${res.status}`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n=== Razorpay API Worker Tests ===`);
  console.log(`Target: ${API_URL}\n`);

  try {
    await testHealth();
    await testCreateOrder();
    await testVerifyPayment();
    await testGetPayment();
    await testAuthGuard();
    await test404();
  } catch (err) {
    console.error('\n❌ Unexpected error during tests:', err);
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
}

run();
