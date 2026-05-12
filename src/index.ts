/**
 * Cloudflare Worker: Razorpay API v2.0
 *
 * Exports:
 * - PaymentService (WorkerEntrypoint) — RPC methods for service binding callers (default export for entrypoint)
 * - fetch handler attached to PaymentService.prototype for HTTP requests (webhooks, health checks)
 *
 * Architecture:
 * - RPC methods: Use PaymentService class methods directly via service bindings
 * - HTTP requests: Use fetch handler for webhooks and health checks
 * This dual-purpose pattern allows one worker to serve both use cases
 */

import { PaymentService } from './entrypoint';
import type { Env, RateLimitInfo } from './types';
import { ERROR_CODES } from './constants';
import { corsPreflightResponse, errorResponse } from './utils/response';
import { createLogger } from './middleware/logger';
import { authenticateRequest } from './middleware/auth';
import { checkRateLimit } from './middleware/rateLimit';
import { handleHealthCheck } from './routes/health';
import { handleCreateOrder } from './routes/orders';
import {
  handleVerifyPayment,
  handleGetPayment,
  handleVerifyWebhook,
  handleCancelSubscription,
} from './routes/payments';

function attachRateLimitHeaders(response: Response, rl: RateLimitInfo): Response {
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', rl.limit.toString());
  headers.set('X-RateLimit-Remaining', rl.remaining.toString());
  headers.set('X-RateLimit-Reset', new Date(rl.resetAt).toISOString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function methodNotAllowed(requestId: string, request: Request, env: Env): Response {
  return errorResponse(
    ERROR_CODES.METHOD_NOT_ALLOWED,
    'Method not allowed',
    `${request.method} is not allowed on this endpoint`,
    405,
    { requestId, request, env }
  );
}

async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  let logger = createLogger(requestId);

  try {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no auth required
    if (path === '/health') {
      return await handleHealthCheck(request, env, logger);
    }

    // Webhook verification — no JWT auth required
    if (path === '/verify-webhook') {
      if (request.method !== 'POST') return methodNotAllowed(requestId, request, env);
      logger = createLogger(requestId, 'razorpay-webhook');
      const rl = await checkRateLimit('razorpay-webhook', 'verify-webhook', env);
      if (rl instanceof Response) return rl;
      const response = await handleVerifyWebhook(request, env, logger, requestId);
      return attachRateLimitHeaders(response, rl);
    }

    // Authenticate — remaining endpoints require service JWT
    const authResult = await authenticateRequest(request, env);
    if (authResult instanceof Response) {
      return authResult;
    }

    const callerId = authResult.serviceId;
    logger = createLogger(requestId, callerId);

    if (env.ENVIRONMENT !== 'local' && !env.RATE_LIMIT_KV) {
      logger.warn('RATE_LIMIT_KV not bound — rate limiting is in-memory only (not distributed)');
    }

    logger.info('Request received', { method: request.method, path, caller: callerId });

    let response: Response;

    if (path === '/create-order') {
      if (request.method !== 'POST') return methodNotAllowed(requestId, request, env);
      const rl = await checkRateLimit(callerId, 'create-order', env);
      if (rl instanceof Response) return rl;
      response = await handleCreateOrder(request, env, logger, requestId);
      response = attachRateLimitHeaders(response, rl);

    } else if (path === '/verify-payment') {
      if (request.method !== 'POST') return methodNotAllowed(requestId, request, env);
      const rl = await checkRateLimit(callerId, 'verify-payment', env);
      if (rl instanceof Response) return rl;
      response = await handleVerifyPayment(request, env, logger, requestId);
      response = attachRateLimitHeaders(response, rl);

    } else if (/^\/payment\/[^/]+$/.test(path)) {
      if (request.method !== 'GET') return methodNotAllowed(requestId, request, env);
      const rl = await checkRateLimit(callerId, 'get-payment', env);
      if (rl instanceof Response) return rl;
      const segments = path.split('/').filter(Boolean);
      const paymentId = segments[1] ?? '';
      response = await handleGetPayment(request, env, logger, requestId, paymentId);
      response = attachRateLimitHeaders(response, rl);

    } else if (/^\/subscription\/[^/]+\/cancel$/.test(path)) {
      if (request.method !== 'POST') return methodNotAllowed(requestId, request, env);
      const rl = await checkRateLimit(callerId, 'cancel-subscription', env);
      if (rl instanceof Response) return rl;
      const segments = path.split('/').filter(Boolean);
      const subscriptionId = segments[1] ?? '';
      response = await handleCancelSubscription(request, env, logger, requestId, subscriptionId);
      response = attachRateLimitHeaders(response, rl);

    } else {
      response = errorResponse(ERROR_CODES.NOT_FOUND, 'Not found',
        `Unknown endpoint: ${path}`, 404, { requestId, request, env });
    }

    const duration = Date.now() - startTime;
    ctx.waitUntil(Promise.resolve(logger.info('Request completed', { duration, status: response.status })));

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Unhandled error', error instanceof Error ? error : undefined, { duration });

    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Internal server error',
      error instanceof Error ? error.message : 'Unknown error',
      500, { requestId, request, env });
  }
}

// Attach fetch handler to PaymentService prototype
// WorkerEntrypoint.fetch only receives Request; env and ctx are available via this.env and this.ctx
PaymentService.prototype.fetch = async function(request: Request): Promise<Response> {
  return handleHttpRequest(request, this.env, this.ctx);
};

export default PaymentService;
