/**
 * Structured logging middleware
 */

import type { LogLevel, LogEntry } from '../types';
import { LOG_LEVELS } from '../constants';

class Logger {
  private requestId?: string;
  private callerId?: string;

  constructor(requestId?: string, callerId?: string) {
    this.requestId = requestId;
    this.callerId = callerId;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>, error?: Error): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(this.requestId && { requestId: this.requestId }),
      ...(this.callerId && { callerId: this.callerId }),
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
}

export function createLogger(requestId?: string, callerId?: string): Logger {
  return new Logger(requestId, callerId);
}

export type { Logger };
