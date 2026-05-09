/**
 * PaymentService WorkerEntrypoint — exposes Razorpay operations as typed RPC methods
 * callable via Cloudflare Service Bindings.
 *
 * Unlike the HTTP route handlers, these methods accept typed parameters and return
 * typed results (or throw Errors). No Request/Response, no HTTP status codes,
 * no JSON serialization — just pure business logic.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env, RazorpayOrder, RazorpayPayment, RazorpaySubscription, RazorpayErrorResponse } from './types';
import {
  RAZORPAY_API_BASE_URL,
  MIN_AMOUNT,
  MAX_AMOUNT,
  MAX_RECEIPT_LENGTH,
  MAX_NOTES_SIZE,
  MAX_NOTE_KEY_LENGTH,
  MAX_NOTE_VALUE_LENGTH,
} from './constants';
import { fetchWithRetry } from './utils/fetch';
import { timingSafeEqual } from './utils/response';

// ─── Exported Interfaces ────────────────────────────────────────────────────────

export interface CreateOrderParams {
  amount: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface VerifyPaymentResult {
  verified: boolean;
  message: string;
}

export interface VerifyWebhookResult {
  verified: boolean;
  message: string;
  payload?: unknown;
}

// ─── Validation Regexes ─────────────────────────────────────────────────────────

const RECEIPT_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const RAZORPAY_PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{14,}$/;
const RAZORPAY_SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{14,}$/;

// ─── PaymentService Class ───────────────────────────────────────────────────────

export class PaymentService extends WorkerEntrypoint<Env> {
  /**
   * Create a Razorpay order.
   * @throws Error with INVALID_INPUT prefix on validation failure
   * @throws Error with RAZORPAY_API_ERROR prefix on Razorpay API failure
   * @throws Error with INTERNAL_ERROR prefix on unexpected failures
   */
  async createOrder(params: CreateOrderParams): Promise<RazorpayOrder> {
    const { amount, currency, receipt, notes } = params;

    // ── Input Validation ──────────────────────────────────────────────────────

    if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      throw new Error('INVALID_INPUT: Amount must be a positive integer in paise');
    }

    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      throw new Error(`INVALID_INPUT: Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} paise`);
    }

    if (currency && currency !== 'INR') {
      throw new Error('INVALID_INPUT: Only INR currency is supported');
    }

    if (receipt !== undefined && receipt !== null) {
      if (typeof receipt !== 'string') {
        throw new Error('INVALID_INPUT: Receipt must be a string');
      }
      if (receipt.length > MAX_RECEIPT_LENGTH) {
        throw new Error(`INVALID_INPUT: Receipt must be ${MAX_RECEIPT_LENGTH} characters or fewer`);
      }
      if (!RECEIPT_RE.test(receipt)) {
        throw new Error('INVALID_INPUT: Receipt must contain only alphanumeric characters, underscores, or hyphens');
      }
    }

    if (notes !== undefined) {
      if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) {
        throw new Error('INVALID_INPUT: Notes must be a key-value object');
      }
      if (Object.keys(notes).length > MAX_NOTES_SIZE) {
        throw new Error(`INVALID_INPUT: Notes must have at most ${MAX_NOTES_SIZE} key-value pairs`);
      }
      for (const [k, v] of Object.entries(notes)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new Error('INVALID_INPUT: All note keys and values must be strings');
        }
        if (k.length > MAX_NOTE_KEY_LENGTH) {
          throw new Error(`INVALID_INPUT: Note keys must be ${MAX_NOTE_KEY_LENGTH} characters or fewer`);
        }
        if (v.length > MAX_NOTE_VALUE_LENGTH) {
          throw new Error(`INVALID_INPUT: Note values must be ${MAX_NOTE_VALUE_LENGTH} characters or fewer`);
        }
      }
    }

    // ── Razorpay API Call ─────────────────────────────────────────────────────

    const razorpayAuth = btoa(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`);

    try {
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
        2 // max retries
      );

      const data = await response.json() as RazorpayOrder | RazorpayErrorResponse;

      if (!response.ok) {
        const errData = data as RazorpayErrorResponse;
        throw new Error(`RAZORPAY_API_ERROR: ${errData.error?.description || 'Failed to create order'}`);
      }

      const orderData = data as RazorpayOrder;
      
      // Inject the key_id used to create the order so the frontend can use it directly,
      // avoiding mismatches between Pages env and Worker env.
      return {
        ...orderData,
        key_id: this.env.RAZORPAY_KEY_ID,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RAZORPAY_API_ERROR:')) {
        throw error;
      }
      throw new Error(`INTERNAL_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Verify a Razorpay payment signature using HMAC-SHA256 with timing-safe comparison.
   * @throws Error with INVALID_INPUT prefix if params are missing
   * @throws Error with UNAUTHORIZED prefix if signature is invalid
   * @throws Error with INTERNAL_ERROR prefix on unexpected failures
   */
  async verifyPaymentSignature(
    orderId: string,
    paymentId: string,
    signature: string
  ): Promise<VerifyPaymentResult> {
    if (!orderId || !paymentId || !signature) {
      throw new Error('INVALID_INPUT: orderId, paymentId, and signature are required');
    }

    try {
      const text = `${orderId}|${paymentId}`;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(this.env.RAZORPAY_KEY_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
      const generatedSignature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // Constant-time comparison — never short-circuits on length
      const isValid = timingSafeEqual(generatedSignature, signature);

      if (!isValid) {
        throw new Error('UNAUTHORIZED: Payment signature verification failed');
      }

      return { verified: true, message: 'Payment signature verified' };
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('UNAUTHORIZED:') || error.message.startsWith('INVALID_INPUT:'))) {
        throw error;
      }
      throw new Error(`INTERNAL_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch payment details from Razorpay API.
   * @throws Error with INVALID_INPUT prefix if paymentId format is invalid
   * @throws Error with RAZORPAY_API_ERROR prefix if Razorpay returns error
   * @throws Error with INTERNAL_ERROR prefix on unexpected failures
   */
  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    if (!paymentId || !RAZORPAY_PAYMENT_ID_RE.test(paymentId)) {
      throw new Error('INVALID_INPUT: Payment ID must match format pay_XXXXXXXXXXXXXX');
    }

    const razorpayAuth = btoa(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`);

    try {
      const response = await fetchWithRetry(
        `${RAZORPAY_API_BASE_URL}/payments/${paymentId}`,
        {
          method: 'GET',
          headers: { Authorization: `Basic ${razorpayAuth}` },
        },
        2 // max retries
      );

      const data = await response.json() as RazorpayPayment | RazorpayErrorResponse;

      if (!response.ok) {
        const errData = data as RazorpayErrorResponse;
        throw new Error(`RAZORPAY_API_ERROR: ${errData.error?.description || 'Failed to fetch payment'}`);
      }

      return data as RazorpayPayment;
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('RAZORPAY_API_ERROR:') || error.message.startsWith('INVALID_INPUT:'))) {
        throw error;
      }
      throw new Error(`INTERNAL_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Cancel a Razorpay subscription immediately (zero retries).
   * @throws Error with INVALID_INPUT prefix if subscriptionId format is invalid
   * @throws Error with RAZORPAY_API_ERROR prefix if Razorpay returns error
   * @throws Error with INTERNAL_ERROR prefix on unexpected failures
   */
  async cancelSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    if (!subscriptionId || !RAZORPAY_SUBSCRIPTION_ID_RE.test(subscriptionId)) {
      throw new Error('INVALID_INPUT: Subscription ID must match format sub_XXXXXXXXXXXXXX');
    }

    const razorpayAuth = btoa(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`);

    try {
      // Zero retries — subscription cancellation must not be retried on failure
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
        0 // zero retries
      );

      const data = await response.json() as RazorpaySubscription | RazorpayErrorResponse;

      if (!response.ok) {
        const errData = data as RazorpayErrorResponse;
        throw new Error(`RAZORPAY_API_ERROR: ${errData.error?.description || 'Failed to cancel subscription'}`);
      }

      return data as RazorpaySubscription;
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('RAZORPAY_API_ERROR:') || error.message.startsWith('INVALID_INPUT:'))) {
        throw error;
      }
      throw new Error(`INTERNAL_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Verify a Razorpay webhook signature using HMAC-SHA256.
   * @throws Error with INVALID_INPUT prefix if params are missing
   * @throws Error with UNAUTHORIZED prefix if signature is invalid
   * @throws Error with INTERNAL_ERROR prefix if webhook secret is not configured
   */
  async verifyWebhookSignature(body: string, signature: string): Promise<VerifyWebhookResult> {
    if (!body || !signature) {
      throw new Error('INVALID_INPUT: body and signature are required');
    }

    if (!this.env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('INTERNAL_ERROR: RAZORPAY_WEBHOOK_SECRET is not configured');
    }

    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(this.env.RAZORPAY_WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      const generatedSignature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const isValid = timingSafeEqual(generatedSignature, signature);

      if (!isValid) {
        throw new Error('UNAUTHORIZED: Webhook signature verification failed');
      }

      // Parse the body as JSON for the payload field
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        // If body isn't valid JSON, still return verified but without parsed payload
        payload = undefined;
      }

      return { verified: true, message: 'Webhook signature verified', payload };
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('UNAUTHORIZED:') || error.message.startsWith('INVALID_INPUT:') || error.message.startsWith('INTERNAL_ERROR:'))) {
        throw error;
      }
      throw new Error(`INTERNAL_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
