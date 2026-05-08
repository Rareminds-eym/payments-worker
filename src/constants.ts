/**
 * Application constants and configuration
 */

// API Configuration
export const API_VERSION = '2.0.0';
export const SERVICE_NAME = 'razorpay-api';

// Auth — shared between auth middleware and any JWT-issuing service
export const SERVICE_ID = 'functions-payment-service';

// Razorpay API
export const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';

// Validation Limits
export const MIN_AMOUNT = 100; // ₹1 in paise
// ₹1 lakh cap — business rule for this platform. Razorpay supports up to ₹5 crore.
// Increase this limit if high-value transactions are required.
export const MAX_AMOUNT = 10000000;
export const MAX_RECEIPT_LENGTH = 40;
export const MAX_NOTES_SIZE = 15;       // Max 15 key-value pairs (Razorpay limit)
export const MAX_NOTE_KEY_LENGTH = 40;  // Razorpay key length limit
export const MAX_NOTE_VALUE_LENGTH = 256; // Razorpay value length limit

// Rate Limiting (per API key)
export const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = {
  'create-order': 20,
  'verify-payment': 30,
  'get-payment': 50,
  'cancel-subscription': 10,
  'verify-webhook': 100,
} as const;

// Timeouts
export const RAZORPAY_API_TIMEOUT_MS = 10000; // 10 seconds
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000; // 15 seconds

// CORS Configuration
// Origins are configured via ALLOWED_ORIGINS in wrangler.toml [vars] (comma-separated).
// For local dev, set ALLOWED_ORIGINS in .dev.vars to include localhost origins.

// 1 hour — shorter than 24h to avoid stale CORS config being cached during incidents
export const CORS_MAX_AGE = 3600;

// Logging
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
} as const;

// Error Codes
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_INPUT: 'INVALID_INPUT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  RAZORPAY_API_ERROR: 'RAZORPAY_API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  TIMEOUT: 'TIMEOUT',
} as const;
