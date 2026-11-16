import type { HttpClient } from '../../http';
import type { CredentialResolver } from '../adapter';
import type { DeliveryReceipt, DeliverySummary } from '../capabilities';
import type { IdempotencyStore } from '../idempotency';
import type { Logger } from '../logger';

export interface DispatchOptions {
  http: HttpClient;
  credentials: CredentialResolver;
  logger?: Logger;
  idempotencyStore?: IdempotencyStore;
  /** Total attempts per target, including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Per-attempt timeout. Defaults to 15000ms. */
  attemptTimeoutMs?: number;
  /** Base delay for exponential backoff. Defaults to 250ms. */
  baseRetryDelayMs?: number;
  /** Upper bound for the exponential backoff delay. Defaults to 5000ms. */
  maxRetryDelayMs?: number;
  /** Injectable sleep used between retries; tests can replace it with a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Defaults to Math.random. */
  random?: () => number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface DispatchResult extends DeliveryReceipt {
  summary: DeliverySummary;
  deduplicated: boolean;
  dryRun: boolean;
}
