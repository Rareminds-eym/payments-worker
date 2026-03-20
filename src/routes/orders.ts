/**
 * Order creation endpoint
 */

import type { Env, CreateOrderRequest, CreateOrderResponse, RazorpayOrder, RazorpayErrorResponse } from '../types';
import {
  RAZORPAY_API_BASE_URL, MIN_AMOUNT, MAX_AMOUNT, MAX_RECEIPT_LENGTH,
  MAX_NOTES_SIZE, MAX_NOTE_KEY_LENGTH, MAX_NOTE_VALUE_LENGTH, ERROR_CODES,
} from '../constants';
import { jsonResponse, errorResponse, requireJsonContentType } from '../utils/response';
import { fetchWithRetry } from '../utils/fetch';
import type { Logger } from '../middleware/logger';

export async function handleCreateOrder(
  request: Request,
  env: Env,
  logger: Logger,
  requestId: string
): Promise<Response> {
  const opts = { requestId, request };

  const ctError = requireJsonContentType(request, requestId);
  if (ctError) return ctError;

  let body: CreateOrderRequest;
  try {
    body = await request.json() as CreateOrderRequest;
  } catch {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid JSON', 'Request body must be valid JSON', 400, opts);
  }

  const { amount, currency, receipt, notes } = body;

  if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid amount',
      'Amount must be a positive integer in paise (e.g. 99900 for ₹999)', 400, opts);
  }

  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Amount out of range',
      `Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} paise`, 400, opts);
  }

  if (currency && currency !== 'INR') {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid currency', 'Only INR currency is supported', 400, opts);
  }

  if (receipt && receipt.length > MAX_RECEIPT_LENGTH) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid receipt',
      `Receipt must be ${MAX_RECEIPT_LENGTH} characters or fewer`, 400, opts);
  }

  // Razorpay accepts alphanumeric, underscore, hyphen only
  if (receipt && !/^[a-zA-Z0-9_-]{1,40}$/.test(receipt)) {
    return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid receipt',
      'Receipt must contain only alphanumeric characters, underscores, or hyphens', 400, opts);
  }

  if (notes !== undefined) {
    if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) {
      return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid notes', 'Notes must be a key-value object', 400, opts);
    }
    if (Object.keys(notes).length > MAX_NOTES_SIZE) {
      return errorResponse(ERROR_CODES.INVALID_INPUT, 'Too many notes',
        `Notes must have at most ${MAX_NOTES_SIZE} key-value pairs`, 400, opts);
    }
    for (const [k, v] of Object.entries(notes)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid notes', 'All note keys and values must be strings', 400, opts);
      }
      if (k.length > MAX_NOTE_KEY_LENGTH) {
        return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid notes',
          `Note keys must be ${MAX_NOTE_KEY_LENGTH} characters or fewer`, 400, opts);
      }
      if (v.length > MAX_NOTE_VALUE_LENGTH) {
        return errorResponse(ERROR_CODES.INVALID_INPUT, 'Invalid notes',
          `Note values must be ${MAX_NOTE_VALUE_LENGTH} characters or fewer`, 400, opts);
      }
    }
  }

  logger.info('Creating Razorpay order', { amount, currency: currency || 'INR' });

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  try {
    const response = await fetchWithRetry(
      `${RAZORPAY_API_BASE_URL}/orders`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': requestId,
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

    const data = await response.json() as RazorpayOrder | RazorpayErrorResponse;

    if (!response.ok) {
      const errData = data as RazorpayErrorResponse;
      logger.error('Razorpay API error', undefined, {
        status: response.status,
        errorCode: errData.error?.code,
        description: errData.error?.description,
      });
      return errorResponse(ERROR_CODES.RAZORPAY_API_ERROR, 'Failed to create order',
        errData.error?.description || 'Unknown error', response.status, opts);
    }

    logger.info('Order created successfully', { orderId: (data as RazorpayOrder).id });

    const result: CreateOrderResponse = { success: true, order: data as RazorpayOrder };
    return jsonResponse(result, 200, request, { 'X-Request-ID': requestId });
  } catch (error) {
    logger.error('Create order error', error instanceof Error ? error : undefined);
    return errorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to create order',
      error instanceof Error ? error.message : 'Unknown error', 500, opts);
  }
}
