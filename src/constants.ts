/**
 * Application constants and configuration
 */

// API Configuration
export const API_VERSION = '2.0.0';
export const SERVICE_NAME = 'razorpay-api';

// Razorpay API
export const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';

// Validation Limits
export const MIN_AMOUNT = 100; // ₹1 in paise
export const MAX_AMOUNT = 10000000; // ₹1 lakh in paise
export const MAX_RECEIPT_LENGTH = 40;
export const MAX_NOTES_SIZE = 15; // Max 15 key-value pairs

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
export const ALLOWED_ORIGINS = [
  'https://skillpassport.com',
  'https://www.skillpassport.com',
  'http://localhost:8788',
  'http://localhost:5173',
  'http://127.0.0.1:8788',
  'http://127.0.0.1:5173',
];

export const CORS_MAX_AGE = 86400; // 24 hours

// Logging
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

// Website Configuration Metadata
// API keys are stored as Cloudflare Secrets, not in source code
export const WEBSITE_METADATA = {
  'skillpassport-prod': {
    id: 'website-a',
    name: 'Skill Passport',
    environment: 'production' as const,
  },
  'skillpassport-dev': {
    id: 'website-a',
    name: 'Skill Passport',
    environment: 'development' as const,
  },
  'legacy': {
    id: 'legacy',
    name: 'Legacy Key',
    environment: 'development' as const,
  },
} as const;

// Error Codes
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_INPUT: 'INVALID_INPUT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  RAZORPAY_API_ERROR: 'RAZORPAY_API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
} as const;
