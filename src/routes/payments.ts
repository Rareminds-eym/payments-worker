/**
 * Payment verification and details endpoints
 */

import type { Env, VerifyPaymentRequest, VerifyPaymentResponse, GetPaymentResponse, RazorpayPayment, RazorpaySubscription, RazorpayErrorResponse, VerifiedPaymentWebhook } from '../types';
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
      error instanceof Error ? error.message : String(error), 500, opts);
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
      error instanceof Error ? error.message : String(error), 500, opts);
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

    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
      return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid webhook event', 'Expected an event object', 400, opts);
    }
    const eventPayload = parsedPayload as Record<string, unknown>;
    const eventType = eventPayload.event;
    const eventSeconds = eventPayload.created_at;
    const receivedAt = Date.now();
    if (typeof eventType !== 'string' || !eventType.length || !Number.isSafeInteger(eventSeconds)
      || Number(eventSeconds) <= 0 || !Number.isSafeInteger(Number(eventSeconds) * 1000)
      || Number(eventSeconds) * 1000 > receivedAt) {
      return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid webhook event', 'Exact event type and provider timestamp required', 400, opts);
    }
    let capture: VerifiedPaymentWebhook['capture'] = null;
    if (eventType === 'payment.captured') {
      const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const entity = object(object(object(eventPayload.payload)?.payment)?.entity);
      if (!entity || entity.entity !== 'payment' || entity.status !== 'captured' || entity.captured !== true
        || typeof entity.id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(entity.id)
        || typeof entity.order_id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(entity.order_id)
        || !Number.isSafeInteger(entity.amount) || Number(entity.amount) <= 0
        || typeof entity.currency !== 'string' || !/^[A-Z]{3}$/.test(entity.currency)
        || entity.amount_refunded !== 0 || !Number.isSafeInteger(entity.created_at)
        || Number(entity.created_at) <= 0 || Number(entity.created_at) > Number(eventSeconds)) {
        return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid capture evidence', 'Complete captured payment and provider event timestamp required', 400, opts);
      }
      capture = { paymentId: entity.id, orderId: entity.order_id, amountMinor: Number(entity.amount), currency: entity.currency,
        capturedAt: Number(eventSeconds) * 1000, paymentCreatedAt: Number(entity.created_at) * 1000 };
    }
    if (!env.WEBHOOK_QUEUE) {
      return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Webhook queue unavailable', 'Durable admission is required', 503, opts);
    }
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
    const bodySha256 = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
    // Delivery age does not change authenticated capture time. Exact signed-body
    // replays enter the durable queue with the same identity. The consumer must
    // deduplicate transactionally with its effects, never in eventually-consistent
    // KV before queue admission. Distinct event bodies cannot collide by payment ID.
    const envelope: VerifiedPaymentWebhook = { event_id: bodySha256, event_type: eventType, payload: eventPayload,
      verification: { kind: 'razorpay_hmac_sha256', bodySha256, receivedAt }, capture };
    await env.WEBHOOK_QUEUE.send(envelope);
    return jsonResponse({ success: true, verified: true, status: 'queued', eventId: bodySha256 }, 200, request, { 'X-Request-ID': requestId });
  } catch (error) {
    logger.error('Verify webhook error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to verify webhook',
      'Webhook admission failed; delivery may be retried', 503, opts);
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
      error instanceof Error ? error.message : String(error), 500, opts);
  }
}
