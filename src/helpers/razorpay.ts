/**
 * Razorpay credential helpers for razorpay-api worker
 */

import type { Env } from '../types';

export function getRazorpayCredentials(env: Env): { keyId: string; keySecret: string } {
  const isTest = env.RAZORPAY_MODE === 'test';
  const keyId = isTest
    ? (env.RAZORPAY_KEY_ID_TEST || env.RAZORPAY_KEY_ID)
    : env.RAZORPAY_KEY_ID;
  const keySecret = isTest
    ? (env.RAZORPAY_KEY_SECRET_TEST || env.RAZORPAY_KEY_SECRET)
    : env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');
  return { keyId, keySecret };
}

export function razorpayAuth(env: Env): string {
  const { keyId, keySecret } = getRazorpayCredentials(env);
  return btoa(`${keyId}:${keySecret}`);
}

export async function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const text = `${orderId}|${paymentId}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  const generated = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return generated === signature;
}
