/**
 * Payment verification and details endpoints
 */

import type { Env, VerifyPaymentRequest, VerifyPaymentResponse, GetPaymentResponse, RazorpayPayment } from '../types';
import { RAZORPAY_API_BASE_URL, ERROR_CODES } from '../constants';
import { jsonResponse, errorResponse } from '../utils/response';
import { fetchWithRetry } from '../utils/fetch';
import type { Logger } from '../middleware/logger';

export async function handleVerifyPayment(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  try {
    const body = await request.json() as VerifyPaymentRequest;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    // Validate required fields
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Missing required fields',
        'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required',
        400,
        requestId
      );
    }

    logger.info('Verifying payment signature', { orderId: razorpay_order_id, paymentId: razorpay_payment_id });

    // Generate signature
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

    const isValid = generatedSignature === razorpay_signature;

    logger.info('Payment signature verification completed', { verified: isValid });

    const result: VerifyPaymentResponse = {
      success: true,
      verified: isValid,
      message: isValid ? 'Payment signature verified' : 'Invalid payment signature',
    };

    return jsonResponse(result, 200, request, {
      'X-Request-ID': requestId,
    });
  } catch (error) {
    logger.error('Verify payment error', error instanceof Error ? error : undefined);
    return errorResponse(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to verify signature',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      requestId
    );
  }
}

export async function handleGetPayment(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string,
  paymentId: string
): Promise<Response> {
  if (!paymentId) {
    return errorResponse(
      ERROR_CODES.INVALID_INPUT,
      'Invalid request',
      'Payment ID is required',
      400,
      requestId
    );
  }

  logger.info('Fetching payment details', { paymentId });

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  try {
    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/payments/${paymentId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
        },
      },
      2,
      logger
    );

    const data = await response.json() as any;

    if (!response.ok) {
      logger.error('Razorpay API error', undefined, { status: response.status, data });
      return errorResponse(
        ERROR_CODES.RAZORPAY_API_ERROR,
        'Failed to fetch payment',
        data.error?.description || 'Unknown error',
        response.status,
        requestId
      );
    }

    logger.info('Payment details fetched successfully', { paymentId });

    const result: GetPaymentResponse = {
      success: true,
      payment: data as RazorpayPayment,
    };

    return jsonResponse(result, 200, request, {
      'X-Request-ID': requestId,
    });
  } catch (error) {
    logger.error('Get payment error', error instanceof Error ? error : undefined);
    return errorResponse(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to fetch payment',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      requestId
    );
  }
}

export async function handleVerifyWebhook(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  const signature = request.headers.get('x-razorpay-signature');
  
  if (!signature) {
    return errorResponse(
      ERROR_CODES.INVALID_INPUT,
      'Missing signature',
      'x-razorpay-signature header is required',
      400,
      requestId
    );
  }

  logger.info('Verifying webhook signature');

  const body = await request.text();

  try {
    const encoder = new TextEncoder();
    const secret = env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_KEY_SECRET;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const generatedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = generatedSignature === signature;

    logger.info('Webhook signature verification completed', { verified: isValid });

    return jsonResponse(
      {
        success: true,
        verified: isValid,
        message: isValid ? 'Webhook signature verified' : 'Invalid webhook signature',
        payload: isValid ? JSON.parse(body) : null,
      },
      200,
      request,
      {
        'X-Request-ID': requestId,
      }
    );
  } catch (error) {
    logger.error('Verify webhook error', error instanceof Error ? error : undefined);
    return errorResponse(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to verify webhook',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      requestId
    );
  }
}

export async function handleCancelSubscription(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string,
  subscriptionId: string
): Promise<Response> {
  if (!subscriptionId) {
    return errorResponse(
      ERROR_CODES.INVALID_INPUT,
      'Invalid request',
      'Subscription ID is required',
      400,
      requestId
    );
  }

  logger.info('Cancelling subscription', { subscriptionId });

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  try {
    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/subscriptions/${subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancel_at_cycle_end: 0 }),
      },
      2,
      logger
    );

    const data = await response.json() as any;

    if (!response.ok) {
      logger.error('Razorpay API error', undefined, { status: response.status, data });
      return errorResponse(
        ERROR_CODES.RAZORPAY_API_ERROR,
        'Failed to cancel subscription',
        data.error?.description || 'Unknown error',
        response.status,
        requestId
      );
    }

    logger.info('Subscription cancelled successfully', { subscriptionId });

    return jsonResponse(
      {
        success: true,
        subscription: data,
      },
      200,
      request,
      {
        'X-Request-ID': requestId,
      }
    );
  } catch (error) {
    logger.error('Cancel subscription error', error instanceof Error ? error : undefined);
    return errorResponse(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to cancel subscription',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      requestId
    );
  }
}
