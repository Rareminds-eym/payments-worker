/**
 * Order creation endpoint
 */

import type { Env, CreateOrderRequest, CreateOrderResponse, RazorpayOrder } from '../types';
import { RAZORPAY_API_BASE_URL, MIN_AMOUNT, MAX_AMOUNT, MAX_RECEIPT_LENGTH, ERROR_CODES } from '../constants';
import { jsonResponse, errorResponse } from '../utils/response';
import { fetchWithRetry } from '../utils/fetch';
import type { Logger } from '../middleware/logger';

export async function handleCreateOrder(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  try {
    const body = await request.json() as CreateOrderRequest;
    const { amount, currency, receipt, notes } = body;

    // Validate amount
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Invalid amount',
        'Amount must be a positive number',
        400,
        requestId
      );
    }

    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Amount out of range',
        `Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} paise`,
        400,
        requestId
      );
    }

    // Validate currency
    if (currency && currency !== 'INR') {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Invalid currency',
        'Only INR currency is supported',
        400,
        requestId
      );
    }

    // Validate receipt
    if (receipt && receipt.length > MAX_RECEIPT_LENGTH) {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Invalid receipt',
        `Receipt must be less than ${MAX_RECEIPT_LENGTH} characters`,
        400,
        requestId
      );
    }

    // Validate notes
    if (notes && typeof notes !== 'object') {
      return errorResponse(
        ERROR_CODES.INVALID_INPUT,
        'Invalid notes',
        'Notes must be an object',
        400,
        requestId
      );
    }

    logger.info('Creating Razorpay order', { amount, currency: currency || 'INR' });

    const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/orders`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount,
          currency: currency || 'INR',
          receipt: receipt || `rcpt_${Date.now()}`,
          notes: notes || {},
        }),
      },
      2,
      logger
    );

    const data = await response.json() as any;

    if (!response.ok) {
      logger.error('Razorpay API error', undefined, { status: response.status, data });
      return errorResponse(
        ERROR_CODES.RAZORPAY_API_ERROR,
        'Failed to create order',
        data.error?.description || 'Unknown error',
        response.status,
        requestId
      );
    }

    logger.info('Order created successfully', { orderId: data.id });

    const result: CreateOrderResponse = {
      success: true,
      order: data as RazorpayOrder,
      key_id: env.RAZORPAY_KEY_ID,
    };

    return jsonResponse(result, 200, request, {
      'X-Request-ID': requestId,
    });
  } catch (error) {
    logger.error('Create order error', error instanceof Error ? error : undefined);
    return errorResponse(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to create order',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      requestId
    );
  }
}
