/**
 * Response utilities
 */

import type { ErrorResponse } from '../types';
import { CORS_MAX_AGE } from '../constants';

function getAllowedOrigins(env?: { ALLOWED_ORIGINS?: string }): string[] {
  // All allowed origins come from ALLOWED_ORIGINS env var — comma-separated.
  // Set in wrangler.toml [vars] for deployed envs, .dev.vars for local dev.
  // If not set, no origins are allowed (fail closed).
  if (!env?.ALLOWED_ORIGINS) return [];
  return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
}

function getCorsHeaders(origin: string | null, env?: { ALLOWED_ORIGINS?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
    'Access-Control-Max-Age': CORS_MAX_AGE.toString(),
    'Access-Control-Expose-Headers': 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Vary': 'Origin',
  };

  if (origin && getAllowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

export function corsPreflightResponse(request: Request, env?: { ALLOWED_ORIGINS?: string }): Response {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin, env),
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  request?: Request,
  additionalHeaders?: Record<string, string>,
  env?: { ALLOWED_ORIGINS?: string }
): Response {
  const origin = request?.headers.get('Origin') || null;

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin, env),
      ...additionalHeaders,
    },
  });
}

/**
 * Options for errorResponse.
 * @property requestId         - UUID for the current request; added as X-Request-ID header and request_id body field
 * @property request           - Incoming Request object; used to read Origin for CORS headers
 * @property env               - Worker env; used to select production vs dev CORS origins
 * @property additionalHeaders - Extra headers merged into the response (e.g. Retry-After)
 */
export interface ErrorResponseOptions {
  requestId?: string;
  request?: Request;
  env?: { ALLOWED_ORIGINS?: string };
  additionalHeaders?: Record<string, string>;
}

/**
 * Build a structured JSON error response.
 * Always pass options as an object — no positional overloads exist.
 */
export function errorResponse(
  code: string,
  message: string,
  details?: unknown,
  status = 500,
  options?: ErrorResponseOptions
): Response {
  const opts = options ?? {};

  const errorBody: ErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
    },
    timestamp: new Date().toISOString(),
    ...(opts.requestId && { request_id: opts.requestId }),
  };

  const origin = opts.request?.headers.get('Origin') || null;

  return new Response(JSON.stringify(errorBody), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin, opts.env),
      ...(opts.requestId && { 'X-Request-ID': opts.requestId }),
      ...opts.additionalHeaders,
    },
  });
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Never short-circuits on length — pads both buffers to the same length
 * and XORs the length difference into the result so different-length
 * strings can never match.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const len = Math.max(bufA.length, bufB.length);
  const padA = new Uint8Array(len); padA.set(bufA);
  const padB = new Uint8Array(len); padB.set(bufB);
  let result = 0;
  for (let i = 0; i < len; i++) result |= padA[i] ^ padB[i];
  result |= bufA.length ^ bufB.length;
  return result === 0;
}

/**
 * Returns a 415 response if the request Content-Type is not application/json.
 * Call this before request.json() in any POST handler.
 */
export function requireJsonContentType(request: Request, requestId?: string): Response | null {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return errorResponse(
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported Media Type',
      'Content-Type must be application/json',
      415,
      { requestId, request }
    );
  }
  return null;
}
