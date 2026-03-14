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

  if (env.SKILLPASSPORT_API_KEY_PROD && apiKey === env.SKILLPASSPORT_API_KEY_PROD) {
    return WEBSITE_METADATA['skillpassport-prod'];
  }

  if (env.SKILLPASSPORT_API_KEY_STAGING && apiKey === env.SKILLPASSPORT_API_KEY_STAGING) {
    return WEBSITE_METADATA['skillpassport-staging'];
  }

  if (env.SKILLPASSPORT_API_KEY_DEV && apiKey === env.SKILLPASSPORT_API_KEY_DEV) {
    return WEBSITE_METADATA['skillpassport-dev'];
  }

  if (env.SKILLPASSPORT_API_KEY_LOCAL && apiKey === env.SKILLPASSPORT_API_KEY_LOCAL) {
    return WEBSITE_METADATA['skillpassport-local'];
  }

  // Legacy fallback
  if (env.LEGACY_API_KEY && apiKey === env.LEGACY_API_KEY) {
    return WEBSITE_METADATA['legacy'];
  }

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
