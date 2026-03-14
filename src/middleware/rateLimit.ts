/**
 * Rate limiting middleware
 * Uses in-memory Map for now, can be upgraded to KV for distributed rate limiting
 */

import type { RateLimitInfo } from '../types';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, ERROR_CODES } from '../constants';
import { errorResponse } from '../utils/response';

// In-memory rate limit store (per worker instance)
// For production with multiple workers, use KV namespace
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  apiKey: string,
  endpoint: keyof typeof RATE_LIMIT_MAX_REQUESTS
): RateLimitInfo | Response {
  const now = Date.now();
  const key = `${apiKey}:${endpoint}`;
  const limit = RATE_LIMIT_MAX_REQUESTS[endpoint];

  // Get or initialize rate limit data
  let data = rateLimitStore.get(key);

  if (!data || now > data.resetAt) {
    // Initialize or reset window
    data = {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    rateLimitStore.set(key, data);
  }

  // Increment request count
  data.count++;

  const remaining = Math.max(0, limit - data.count);
  const allowed = data.count <= limit;

  if (!allowed) {
    return errorResponse(
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      'Rate limit exceeded',
      {
        limit,
        resetAt: new Date(data.resetAt).toISOString(),
        retryAfter: Math.ceil((data.resetAt - now) / 1000),
      },
      429
    );
  }

  return {
    allowed: true,
    limit,
    remaining,
    resetAt: data.resetAt,
  };
}

// Cleanup old entries periodically (called by worker)
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetAt + RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
}
