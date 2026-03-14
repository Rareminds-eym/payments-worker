/**
 * Structured logging middleware
 */

import type { LogLevel, LogEntry } from '../types';
import { LOG_LEVELS } from '../constants';

class Logger {
  private requestId?: string;
  private website?: string;

  constructor(requestId?: string, website?: string) {
    this.requestId = requestId;
    this.website = website;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>, error?: Error): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(this.requestId && { requestId: this.requestId }),
      ...(this.website && { website: this.website }),
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
        },
      }),
      ...(meta && { meta }),
    };

    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(JSON.stringify(entry));
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.ERROR, message, meta, error);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.WARN, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.INFO, message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.DEBUG, message, meta);
  }
}

export function createLogger(requestId?: string, website?: string): Logger {
  return new Logger(requestId, website);
}

export type { Logger };
