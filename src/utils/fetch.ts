/**
 * Fetch utilities with timeout and retry logic
 */

import { RAZORPAY_API_TIMEOUT_MS } from '../constants';
import type { Logger } from '../middleware/logger';

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = RAZORPAY_API_TIMEOUT_MS,
  logger?: Logger
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger?.error('Request timeout', error, { url, timeoutMs });
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 2,
  logger?: Logger
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, RAZORPAY_API_TIMEOUT_MS, logger);

      // Don't retry on client errors (4xx)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // Retry on server errors (5xx)
      if (response.status >= 500 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        logger?.warn(`Server error, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries,
          status: response.status,
        });
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger?.warn(`Request failed, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message,
        });
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
