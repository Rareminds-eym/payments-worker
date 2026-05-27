/**
 * Payment verification and details endpoints
 */

import type { Env, VerifyPaymentRequest, VerifyPaymentResponse, GetPaymentResponse, RazorpayPayment, RazorpaySubscription, RazorpayErrorResponse } from '../types';
import { RAZORPAY_API_BASE_URL, RAZORPAY_API_TIMEOUT_MS, ERROR_CODES } from '../constants';
import { jsonResponse, errorResponse, timingSafeEqual, requireJsonContentType } from '../utils/response';
import { fetchWithRetry, readJsonWithTimeout } from '../utils/fetch';
import type { Logger } from '../middleware/logger';

// Validate Razorpay ID formats to prevent path traversal / SSRF
const RAZORPAY_PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{14,}$/;
const RAZORPAY_SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{14,}$/;

// Max webhook body size — prevents memory exhaustion from oversized payloads
const MAX_WEBHOOK_BODY = 512 * 1024; // 512KB

export async function handleVerifyPayment(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  const opts = { requestId, request };

  const ctError = requireJsonContentType(request, requestId);
  if (ctError) return ctError;

  let body: VerifyPaymentRequest;
  try {
    body = await request.json() as VerifyPaymentRequest;
  } catch {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid JSON', 'Request body must be valid JSON', 400, opts);
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Missing required fields',
      'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required', 400, opts);
  }

  logger.info('Verifying payment signature', { orderId: razorpay_order_id, paymentId: razorpay_payment_id });

  try {
    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.RAZORPAY_KEY_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
    const generatedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison — never short-circuits on length
    const isValid = timingSafeEqual(generatedSignature, razorpay_signature);

    logger.info('Payment signature verification completed', { verified: isValid });

    // Return 422 on invalid sig — makes failure unambiguous at HTTP layer.
    // Callers must not treat a 2xx as success without checking the verified field.
    if (!isValid) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid payment signature',
        'Signature verification failed', 422, opts);
    }

    const result: VerifyPaymentResponse = {
      success: true,
      verified: true,
      message: 'Payment signature verified',
    };

    return jsonResponse(result, 200, request, { 'X-Request-ID': requestId });
  } catch (error) {
    logger.error('Verify payment error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to verify signature',
      error instanceof Error ? error.message : 'Unknown error', 500, opts);
  }
}

export async function handleGetPayment(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string,
  paymentId: string
): Promise<Response> {
  const opts = { requestId, request };

  if (!paymentId || !RAZORPAY_PAYMENT_ID_RE.test(paymentId)) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid payment ID',
      'Payment ID must match format pay_XXXXXXXXXXXXXX', 400, opts);
  }

  logger.info('Fetching payment details', { paymentId });

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  try {
    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/payments/${paymentId}`,
      { method: 'GET', headers: { Authorization: `Basic ${razorpayAuth}` } },
      2,
      logger
    );

    const data = await readJsonWithTimeout<RazorpayPayment | RazorpayErrorResponse>(response, RAZORPAY_API_TIMEOUT_MS, logger);

    if (!response.ok) {
      const errData = data as RazorpayErrorResponse;
      logger.error('Razorpay API error', undefined, {
        status: response.status,
        errorCode: errData.error?.code,
        description: errData.error?.description,
      });
      return errorResponse(ERROR_CODES.RAZORPAY_API_ERROR, 'Failed to fetch payment',
        errData.error?.description || 'Unknown error', response.status, opts);
    }

    logger.info('Payment details fetched successfully', { paymentId });

    const result: GetPaymentResponse = { success: true, payment: data as RazorpayPayment };
    return jsonResponse(result, 200, request, { 'X-Request-ID': requestId });
  } catch (error) {
    logger.error('Get payment error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to fetch payment',
      error instanceof Error ? error.message : 'Unknown error', 500, opts);
  }
}

export async function handleVerifyWebhook(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  const opts = { requestId, request };

  const signature = request.headers.get('x-razorpay-signature');
  if (!signature) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Missing signature',
      'x-razorpay-signature header is required', 400, opts);
  }

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Webhook verification not configured',
      'RAZORPAY_WEBHOOK_SECRET is not set', 500, opts);
  }

  logger.info('Verifying webhook signature');

  // Enforce body size limit — unbounded request.text() can exhaust Worker memory.
  // NaN-safe: if Content-Length is missing or non-numeric, skip the pre-check and
  // rely on the post-read body.length guard below.
  const rawLength = request.headers.get('Content-Length');
  const contentLength = rawLength ? parseInt(rawLength, 10) : 0;
  if (!isNaN(contentLength) && contentLength > MAX_WEBHOOK_BODY) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Payload too large',
      'Webhook body must be 512KB or smaller', 413, opts);
  }

  const body = await request.text();
  if (body.length > MAX_WEBHOOK_BODY) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Payload too large',
      'Webhook body must be 512KB or smaller', 413, opts);
  }

  // Parse JSON before crypto block — malformed body returns 400, not 500
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(body);
  } catch {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid JSON', 'Webhook body must be valid JSON', 400, opts);
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.RAZORPAY_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const generatedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = timingSafeEqual(generatedSignature, signature);

    logger.info('Webhook signature verification completed', { verified: isValid });

    // Return 401 so Razorpay retries the webhook on signature mismatch
    if (!isValid) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Invalid webhook signature',
        'Signature verification failed', 401, opts);
    }

    // Event dedup: Check if we already processed this event
    const eventPayload = parsedPayload as Record<string, any>;
    const eventId = eventPayload?.event_id || eventPayload?.payload?.payment?.entity?.id;
    if (eventId) {
      const seen = await env.RATE_LIMIT_KV.get(`webhook:${eventId}`);
      if (seen) {
        logger.info('Duplicate webhook event, skipping', { eventId });
        return jsonResponse(
          { success: true, verified: true, status: 'duplicate', eventId },
          200, request, { 'X-Request-ID': requestId }
        );
      }
    }

    // Timestamp window check: Reject events older than 5 minutes
    const createdAt = eventPayload?.created_at;
    if (typeof createdAt === 'number') {
      const eventTime = new Date(createdAt * 1000);
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (eventTime < fiveMinutesAgo) {
        logger.warn('Replaying old webhook event rejected', {
          eventId,
          createdAt: eventTime.toISOString(),
          now: new Date().toISOString()
        });
        return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Webhook event too old',
          'Webhook event timestamp is more than 5 minutes in the past', 400, { requestId, request });
      }
    }

    // Mark event as seen (7 day TTL)
    if (eventId) {
      await env.RATE_LIMIT_KV.put(`webhook:${eventId}`, '1', { expirationTtl: 86400 * 7 });
    }

    return jsonResponse(
      { success: true, verified: true, message: 'Webhook signature verified', payload: parsedPayload },
      200, request, { 'X-Request-ID': requestId }
    );
  } catch (error) {
    logger.error('Verify webhook error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to verify webhook',
      error instanceof Error ? error.message : 'Unknown error', 500, opts);
  }
}

export async function handleCancelSubscription(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string,
  subscriptionId: string
): Promise<Response> {
  const opts = { requestId, request };

  if (!subscriptionId || !RAZORPAY_SUBSCRIPTION_ID_RE.test(subscriptionId)) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid subscription ID',
      'Subscription ID must match format sub_XXXXXXXXXXXXXX', 400, opts);
  }

  logger.info('Cancelling subscription', { subscriptionId });

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  try {
    // Set retries to 0 — subscription cancellation must not be retried on failure
    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/subscriptions/${subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${razorpayAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancel_at_cycle_end: 0 }),
      },
      0,
      logger
    );

    const data = await readJsonWithTimeout<RazorpaySubscription | RazorpayErrorResponse>(response, RAZORPAY_API_TIMEOUT_MS, logger);

    if (!response.ok) {
      const errData = data as RazorpayErrorResponse;
      logger.error('Razorpay API error', undefined, {
        status: response.status,
        errorCode: errData.error?.code,
        description: errData.error?.description,
      });
      return errorResponse(ERROR_CODES.RAZORPAY_API_ERROR, 'Failed to cancel subscription',
        errData.error?.description || 'Unknown error', response.status, opts);
    }

    logger.info('Subscription cancelled successfully', { subscriptionId });

    return jsonResponse({ success: true, subscription: data as RazorpaySubscription },
      200, request, { 'X-Request-ID': requestId });
  } catch (error) {
    logger.error('Cancel subscription error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to cancel subscription',
      error instanceof Error ? error.message : 'Unknown error', 500, opts);
  }
}
