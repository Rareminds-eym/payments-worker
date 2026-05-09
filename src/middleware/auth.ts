/**
 * Authentication middleware for the HTTP fetch handler.
 *
 * NOTE: This middleware is only used by the fetch handler for the deep health
 * check endpoint. All payment operations now go through the PaymentService
 * WorkerEntrypoint via Cloudflare Service Binding RPC — which doesn't need
 * JWT auth (the binding itself is the trust boundary).
 *
 * Webhooks use their own signature verification (RAZORPAY_WEBHOOK_SECRET)
 * and don't pass through this middleware either.
 *
 * The RAZORPAY_SERVICE_SECRET env var is kept for backward compatibility
 * but is effectively optional for RPC-based communication.
 */

import * as jose from 'jose';
import type { Env } from '../types';
import { ERROR_CODES, SERVICE_ID } from '../constants';
import { errorResponse } from '../utils/response';

export interface AuthResult {
  serviceId: string;
  userJwtHash?: string;
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthResult | Response> {
  if (!env.RAZORPAY_SERVICE_SECRET) {
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Worker misconfigured',
      'RAZORPAY_SERVICE_SECRET is not set', 500);
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Missing authorization',
      'Authorization: Bearer <service-jwt> is required', 401);
  }

  const token = authHeader.slice(7);

  try {
    const secret = new TextEncoder().encode(env.RAZORPAY_SERVICE_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);

    if (payload.service_id !== SERVICE_ID) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid service JWT', 'Unrecognized service_id', 401);
    }

    return {
      serviceId: payload.service_id as string,
      userJwtHash: payload.user_jwt_hash as string | undefined,
    };
  } catch {
    return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid service JWT', 'JWT verification failed', 401);
  }
}
