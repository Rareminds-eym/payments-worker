/**
 * Response utilities with TypeScript
 */

import type { ErrorResponse } from '../types';
import { ALLOWED_ORIGINS, CORS_MAX_AGE } from '../constants';

function getCorsHeaders(origin: string | null): Record<string, string> {
  // Check if origin is allowed
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, X-Request-ID',
    'Access-Control-Max-Age': CORS_MAX_AGE.toString(),
    'Access-Control-Expose-Headers': 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  };
}

export function corsPreflightResponse(request: Request): Response {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  request?: Request,
  additionalHeaders?: Record<string, string>
): Response {
  const origin = request?.headers.get('Origin') || null;
  
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
      ...additionalHeaders,
    },
  });
}

export function errorResponse(
  code: string,
  message: string,
  details?: unknown,
  status = 500,
  requestId?: string
): Response {
  const errorBody: ErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
    },
    timestamp: new Date().toISOString(),
    ...(requestId && { request_id: requestId }),
  };

  return new Response(JSON.stringify(errorBody), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Errors should be accessible from anywhere
      ...(requestId && { 'X-Request-ID': requestId }),
    },
  });
}
