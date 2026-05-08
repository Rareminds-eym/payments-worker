/**
 * Rate limiting middleware
 * Uses Cloudflare KV when available (distributed, production-safe).
 * Falls back to in-memory Map for local dev where KV is not bound.
 *
 * NOTE: The KV path is NOT atomic — two concurrent requests can both read the
 * same count and both write count+1. This is a known TOCTOU limitation of KV.
 * For true atomicity, migrate to Durable Objects. For a payment worker with
 * low-to-moderate concurrency this is an acceptable trade-off, but document it.
 */

import type { Env, RateLimitInfo } from '../types';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, ERROR_CODES } from '../constants';
import { errorResponse } from '../utils/response';

// In-memory fallback — only used locally when RATE_LIMIT_KV is not bound
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
// Only prune when the store exceeds this threshold to avoid O(n) work on every access
const MAX_STORE_SIZE = 1000;

export async function checkRateLimit(
  callerId: string,
  endpoint: keyof typeof RATE_LIMIT_MAX_REQUESTS,
  env: Env,
): Promise<RateLimitInfo | Response> {
  return env.RATE_LIMIT_KV
    ? checkRateLimitKV(callerId, endpoint, env)
    : checkRateLimitMemory(callerId, endpoint);
}

// ─── KV-backed (production) ───────────────────────────────────────────────────

async function checkRateLimitKV(
  callerId: string,
  endpoint: keyof typeof RATE_LIMIT_MAX_REQUESTS,
  env: Env
): Promise<RateLimitInfo | Response> {
  const now = Date.now();
  const limit = RATE_LIMIT_MAX_REQUESTS[endpoint];
  const key = `rl:${callerId}:${endpoint}`;
  const ttlSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

  const stored = await env.RATE_LIMIT_KV!.get<{ count: number; resetAt: number }>(key, 'json');

  let count: number;
  let resetAt: number;

  if (!stored || now > stored.resetAt) {
    count = 1;
    resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    count = stored.count + 1;
    resetAt = stored.resetAt;
  }

  await env.RATE_LIMIT_KV!.put(key, JSON.stringify({ count, resetAt }), { expirationTtl: ttlSeconds });

  const retryAfter = Math.ceil((resetAt - now) / 1000);

  if (count > limit) {
    return rateLimitExceededResponse(limit, resetAt, retryAfter);
  }

  return { allowed: true, limit, remaining: Math.max(0, limit - count), resetAt };
}

// ─── In-memory fallback (local dev) ──────────────────────────────────────────

function checkRateLimitMemory(
  callerId: string,
  endpoint: keyof typeof RATE_LIMIT_MAX_REQUESTS
): RateLimitInfo | Response {
  const now = Date.now();
  const key = `${callerId}:${endpoint}`;
  const limit = RATE_LIMIT_MAX_REQUESTS[endpoint];

  let data = rateLimitStore.get(key);

  if (!data || now > data.resetAt) {
    // Only prune expired entries when the store is large — avoids O(n) on every window reset
    if (rateLimitStore.size > MAX_STORE_SIZE) {
      for (const [k, v] of rateLimitStore) {
        if (now > v.resetAt) rateLimitStore.delete(k);
      }
    }
    data = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(key, data);
  }

  data.count++;

  const retryAfter = Math.ceil((data.resetAt - now) / 1000);

  if (data.count > limit) {
    return rateLimitExceededResponse(limit, data.resetAt, retryAfter);
  }

  return { allowed: true, limit, remaining: Math.max(0, limit - data.count), resetAt: data.resetAt };
}

// ─── Shared 429 response builder ─────────────────────────────────────────────

function rateLimitExceededResponse(limit: number, resetAt: number, retryAfter: number): Response {
  return errorResponse(
    ERROR_CODES.RATE_LIMIT_EXCEEDED,
    'Rate limit exceeded',
    { limit, resetAt: new Date(resetAt).toISOString(), retryAfter },
    429,
    // Use options object — avoids positional arg confusion with env/additionalHeaders
    { additionalHeaders: { 'Retry-After': retryAfter.toString() } }
  );
}
