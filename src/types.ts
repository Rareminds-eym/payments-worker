/**
 * Type definitions for Razorpay Worker
 */

// Environment bindings
export interface Env {
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  // Test mode toggle: 'test' or 'live'
  RAZORPAY_MODE?: string;
  RAZORPAY_KEY_ID_TEST?: string;
  RAZORPAY_KEY_SECRET_TEST?: string;

  // API Keys for website authentication (stored as Cloudflare Secrets)
  SKILLPASSPORT_API_KEY_PROD: string;
  SKILLPASSPORT_API_KEY_DEV: string;
  LEGACY_API_KEY?: string;
  SHARED_API_KEY?: string; // Deprecated fallback

  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;

  // Service bindings
  EMAIL_SERVICE?: Fetcher;

  ENVIRONMENT: 'development' | 'production';

  // Future: KV for rate limiting
  RATE_LIMIT_KV?: KVNamespace;
}

// Website configuration
export interface WebsiteConfig {
  id: string;
  name: string;
  environment: 'development' | 'production';
}

// Request context (added by middleware)
export interface RequestContext {
  requestId: string;
  website: WebsiteConfig;
  startTime: number;
}

// Razorpay API Types
export interface CreateOrderRequest {
  amount: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface CreateOrderResponse {
  success: true;
  order: RazorpayOrder;
  key_id: string;
}

export interface RazorpayOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: 'created' | 'attempted' | 'paid';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface VerifyPaymentRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface VerifyPaymentResponse {
  success: true;
  verified: boolean;
  message: string;
}

export interface RazorpayPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string;
  method: string;
  captured: boolean;
  email?: string;
  contact?: string;
  created_at: number;
}

export interface GetPaymentResponse {
  success: true;
  payment: RazorpayPayment;
}

export interface CancelSubscriptionResponse {
  success: true;
  subscription: RazorpaySubscription;
}

export interface RazorpaySubscription {
  id: string;
  entity: 'subscription';
  status: 'created' | 'authenticated' | 'active' | 'paused' | 'halted' | 'cancelled' | 'completed' | 'expired';
  current_start?: number;
  current_end?: number;
  ended_at?: number;
  quantity: number;
  notes: Record<string, string>;
  charge_at?: number;
  start_at?: number;
  end_at?: number;
  auth_attempts: number;
  total_count: number;
  paid_count: number;
  customer_notify: number;
  created_at: number;
}

export interface VerifyWebhookResponse {
  success: true;
  verified: boolean;
  message: string;
  payload: unknown | null;
}

// Error Response
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
  request_id?: string;
}

// Health Check Response
export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  uptime?: number;
  endpoints: string[];
  checks?: {
    razorpay?: 'ok' | 'error';
  };
}

// Logging
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  website?: string;
  duration?: number;
  error?: {
    message: string;
    stack?: string;
  };
  meta?: Record<string, unknown>;
}

// Rate Limiting
export interface RateLimitInfo {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}
