import { logger } from "../lib/logger.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
}

const defaults: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  label: string,
  options?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, retryableStatuses } = {
    ...defaults,
    ...options,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      lastError = err;

      const isRetryable = err instanceof Error && retryableStatuses.some((s) =>
        err.message.includes(String(s)),
      );

      const httpErr = err as { status?: number };
      const isHttpRetryable = httpErr.status ? retryableStatuses.includes(httpErr.status) : false;

      if (!isRetryable && !isHttpRetryable) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        logger.warn(
          { attempt, maxRetries, delayMs: delay, label },
          `Retryable error — retrying ${label}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}
