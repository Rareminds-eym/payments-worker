/**
 * Health check endpoint
 */

import type { Env, HealthCheckResponse } from '../types';
import { API_VERSION, SERVICE_NAME, RAZORPAY_API_BASE_URL } from '../constants';
import { jsonResponse } from '../utils/response';
import { fetchWithTimeout } from '../utils/fetch';
import type { Logger } from '../middleware/logger';

const workerStartTime = Date.now();

export async function handleHealthCheck(
  request: Request,
  env: Env,
  logger: Logger
): Promise<Response> {
  const startTime = Date.now();

  // Basic health check
  const health: HealthCheckResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: API_VERSION,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - workerStartTime,
    endpoints: [
      'POST /create-order',
      'POST /verify-payment',
      'GET /payment/:id',
      'POST /subscription/:id/cancel',
      'POST /verify-webhook',
      'GET /health',
    ],
  };

  // Optional: Check Razorpay API connectivity (only if ?deep=true)
  const url = new URL(request.url);
  if (url.searchParams.get('deep') === 'true') {
    health.checks = {
      razorpay: await checkRazorpayConnection(env, logger),
    };

    // Set status based on checks
    if (health.checks.razorpay === 'error') {
      health.status = 'degraded';
    }
  }

  const duration = Date.now() - startTime;
  logger.info('Health check completed', { duration, status: health.status });

  return jsonResponse(health, 200, request);
}

async function checkRazorpayConnection(env: Env, logger: Logger): Promise<'ok' | 'error'> {
  try {
    // Try to fetch a non-existent order (should return 400, but proves API is reachable)
    const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const response = await fetchWithTimeout(
      `${RAZORPAY_API_BASE_URL}/orders/order_test`,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
      },
      5000,
      logger
    );

    // Any response (even 400/404) means API is reachable
    return response.status < 500 ? 'ok' : 'error';
  } catch (error) {
    logger.error('Razorpay health check failed', error instanceof Error ? error : undefined);
    return 'error';
  }
}
