/**
 * Authentication middleware for the HTTP fetch handler.
 *
 * Used for all non-health, non-webhook endpoints reaching the fetch handler
 * (`/create-order`, `/verify-payment`, `/payment/:id`, `/subscription/:id/cancel`).
 *
 * Payment operations also go through the PaymentService WorkerEntrypoint
 * via Cloudflare Service Binding RPC — which uses the binding itself as the
 * trust boundary and does NOT need this JWT middleware.
 *
 * Webhooks use their own signature verification (RAZORPAY_WEBHOOK_SECRET).
 * Health checks skip auth entirely.
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

    if (typeof payload.service_id !== 'string') {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid service JWT', 'Malformed payload: service_id must be a string', 401);
    }

    if (payload.service_id !== SERVICE_ID) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid service JWT', 'Unrecognized service_id', 401);
    }

    return {
      serviceId: payload.service_id,
      userJwtHash: typeof payload.user_jwt_hash === 'string' ? payload.user_jwt_hash : undefined,
    };
  } catch {
    return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid service JWT', 'JWT verification failed', 401);
  }
}
