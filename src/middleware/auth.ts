/**
 * Authentication middleware
 */

import type { Env, WebsiteConfig } from '../types';
import { WEBSITE_METADATA, ERROR_CODES } from '../constants';
import { errorResponse } from '../utils/response';

export function authenticateRequest(request: Request, env: Env): WebsiteConfig | Response {
  const apiKey = request.headers.get('X-API-Key');

  if (!apiKey) {
    return errorResponse(
      ERROR_CODES.UNAUTHORIZED,
      'Missing API key',
      'X-API-Key header is required',
      401
    );
  }

  // Check against environment-based API keys
  if (apiKey === env.SKILLPASSPORT_API_KEY_PROD) {
    return WEBSITE_METADATA['skillpassport-prod'];
  }
  
  if (apiKey === env.SKILLPASSPORT_API_KEY_DEV) {
    return WEBSITE_METADATA['skillpassport-dev'];
  }
  
  // Optional legacy key for backward compatibility
  if (env.LEGACY_API_KEY && apiKey === env.LEGACY_API_KEY) {
    return WEBSITE_METADATA['legacy'];
  }
  
  // Deprecated: Fallback to old SHARED_API_KEY for backward compatibility
  if (env.SHARED_API_KEY && apiKey === env.SHARED_API_KEY) {
    return {
      id: 'legacy',
      name: 'Legacy Key',
      environment: env.ENVIRONMENT,
    };
  }

  return errorResponse(
    ERROR_CODES.UNAUTHORIZED,
    'Invalid API key',
    'The provided API key is not authorized',
    401
  );
}
