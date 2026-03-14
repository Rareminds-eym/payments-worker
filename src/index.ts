/**
 * Cloudflare Worker: Razorpay API v2.0
 * Shared payment processing for multiple websites
 * 
 * Features:
 * - TypeScript with full type safety
 * - Per-website API key authentication
 * - Rate limiting per endpoint
 * - Structured logging with request IDs
 * - Retry logic with exponential backoff
 * - Request timeouts
 * - CORS with origin validation
 * - Comprehensive error handling
 */

import type { Env } from './types';
import { ERROR_CODES } from './constants';
import { corsPreflightResponse, errorResponse } from './utils/response';
import { createLogger } from './middleware/logger';
import { authenticateRequest } from './middleware/auth';
import { checkRateLimit, cleanupRateLimitStore } from './middleware/rateLimit';
import { handleHealthCheck } from './routes/health';
import { handleCreateOrder } from './routes/orders';
import {
  handleVerifyPayment,
  handleGetPayment,
  handleVerifyWebhook,
  handleCancelSubscription,
} from './routes/payments';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(request);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth required)
    if (path === '/health') {
      const logger = createLogger(requestId);
      return await handleHealthCheck(request, env, logger);
    }

    // Authenticate request
    const authResult = authenticateRequest(request, env);
    if (authResult instanceof Response) {
      return authResult; // Auth failed, return error response
    }

    const website = authResult;
    const logger = createLogger(requestId, website.id);

    logger.info('Request received', {
      method: request.method,
      path,
      website: website.name,
    });

    try {
      // Route to appropriate handler
      let response: Response;

      if (path === '/create-order' && request.method === 'POST') {
        // Rate limit check
        const rateLimitResult = checkRateLimit(website.id, 'create-order');
        if (rateLimitResult instanceof Response) {
          return rateLimitResult;
        }

        response = await handleCreateOrder(request, env, logger, requestId);
      } else if (path === '/verify-payment' && request.method === 'POST') {
        const rateLimitResult = checkRateLimit(website.id, 'verify-payment');
        if (rateLimitResult instanceof Response) {
          return rateLimitResult;
        }

        response = await handleVerifyPayment(request, env, logger, requestId);
      } else if (path === '/verify-webhook' && request.method === 'POST') {
        const rateLimitResult = checkRateLimit(website.id, 'verify-webhook');
        if (rateLimitResult instanceof Response) {
          return rateLimitResult;
        }

        response = await handleVerifyWebhook(request, env, logger, requestId);
      } else if (path.startsWith('/payment/') && request.method === 'GET') {
        const rateLimitResult = checkRateLimit(website.id, 'get-payment');
        if (rateLimitResult instanceof Response) {
          return rateLimitResult;
        }

        const paymentId = path.split('/')[2];
        response = await handleGetPayment(request, env, logger, requestId, paymentId);
      } else if (path.startsWith('/subscription/') && path.endsWith('/cancel') && request.method === 'POST') {
        const rateLimitResult = checkRateLimit(website.id, 'cancel-subscription');
        if (rateLimitResult instanceof Response) {
          return rateLimitResult;
        }

        const subscriptionId = path.split('/')[2];
        response = await handleCancelSubscription(request, env, logger, requestId, subscriptionId);
      } else {
        response = errorResponse(
          ERROR_CODES.NOT_FOUND,
          'Not found',
          `Unknown endpoint: ${path}`,
          404,
          requestId
        );
      }

      const duration = Date.now() - startTime;
      logger.info('Request completed', { duration, status: response.status });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Unhandled error', error instanceof Error ? error : undefined, { duration });

      return errorResponse(
        ERROR_CODES.INTERNAL_ERROR,
        'Internal server error',
        error instanceof Error ? error.message : 'Unknown error',
        500,
        requestId
      );
    }
  },

  // Scheduled handler for cleanup tasks
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Cleanup old rate limit entries
    cleanupRateLimitStore();
  },
};
