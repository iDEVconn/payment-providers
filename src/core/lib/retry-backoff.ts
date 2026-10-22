import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  RETRY_STATUS,
  type PaymentOperation,
  type RetryState,
} from '../../contracts/index';
import { PaymentConfigurationError } from './payment-configuration-error';
import type { OperationStore } from './persistence/payment-reliability-store';

/** First delay after an unsuccessful attempt (1 min); doubles with every further attempt. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 60_000;
/** Longest delay between two attempts (1 h). */
export const DEFAULT_RETRY_MAX_DELAY_MS = 3_600_000;
/**
 * Unsuccessful attempts after which a row gets `retryStatus: 'gave_up'`. With the default delays
 * (1, 2, 4, 8, 16, 32 min, then 60 min) the 100th attempt comes 5643 min (about 94 h) after the
 * first failure: longer than PayPal's own redelivery window (about 3 days) with a day of margin.
 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 100;
/** Largest accepted `retryBaseDelayMs` / `retryMaxDelayMs` (7 days). */
export const MAX_RETRY_DELAY_MS = 604_800_000;
/** Largest accepted `maxAttempts`. */
export const MAX_RETRY_ATTEMPTS = 1_000_000;
/** A `submitted` operation without a provider reference this long after its claim is stale (5 min). */
export const DEFAULT_SUBMITTED_STALE_AFTER_MS = 300_000;

/**
 * Backoff of reconciliation and recovery (issues #8, #20). After an unsuccessful or skipped attempt
 * a row waits `retryBaseDelayMs * 2^(attempts - 1)`, at most `retryMaxDelayMs`; after `maxAttempts`
 * it gets `retryStatus: 'gave_up'` and is never selected again until a host resets it.
 */
export type RetryBackoffOptions = {
  /** Integer ms, 1 to `MAX_RETRY_DELAY_MS`. Default `DEFAULT_RETRY_BASE_DELAY_MS`. */
  retryBaseDelayMs?: number;
  /** Integer ms, `retryBaseDelayMs` to `MAX_RETRY_DELAY_MS`. Default `DEFAULT_RETRY_MAX_DELAY_MS`. */
  retryMaxDelayMs?: number;
  /** Integer, 1 to `MAX_RETRY_ATTEMPTS`. Default `DEFAULT_RETRY_MAX_ATTEMPTS`. */
  maxAttempts?: number;
};

export type RetryBackoffPolicy = Required<RetryBackoffOptions>;

/** The fields a deferral writes onto an operation or an evidence row. */
export type RetryDeferral = Required<RetryState>;

function requirePositiveInteger(
  value: number | undefined,
  key: string,
  service: string,
  fallback: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new PaymentConfigurationError(
      `${service} option ${key} must be an integer from 1 to ${max}`,
      [key],
    );
  }
  return value;
}

/** Validates the options at construction: an invalid value must never disable the backoff. */
export function resolveRetryBackoffPolicy(
  options: RetryBackoffOptions,
  service: string,
): RetryBackoffPolicy {
  const retryBaseDelayMs = requirePositiveInteger(
    options.retryBaseDelayMs,
    'retryBaseDelayMs',
    service,
    DEFAULT_RETRY_BASE_DELAY_MS,
    MAX_RETRY_DELAY_MS,
  );
  const retryMaxDelayMs = requirePositiveInteger(
    options.retryMaxDelayMs,
    'retryMaxDelayMs',
    service,
    Math.max(DEFAULT_RETRY_MAX_DELAY_MS, retryBaseDelayMs),
    MAX_RETRY_DELAY_MS,
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new PaymentConfigurationError(
      `${service} option retryMaxDelayMs must not be smaller than retryBaseDelayMs`,
      ['retryMaxDelayMs'],
    );
  }
  const maxAttempts = requirePositiveInteger(
    options.maxAttempts,
    'maxAttempts',
    service,
    DEFAULT_RETRY_MAX_ATTEMPTS,
    MAX_RETRY_ATTEMPTS,
  );
  return { retryBaseDelayMs, retryMaxDelayMs, maxAttempts };
}

/** Same validation for a single positive duration option (e.g. `submittedStaleAfterMs`). */
export function resolvePositiveDurationMs(
  value: number | undefined,
  key: string,
  service: string,
  fallback: number,
): number {
  return requirePositiveInteger(value, key, service, fallback);
}

/** A stored attempt count as a safe integer: anything else (null, NaN, negative, text) is 0. */
function storedAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Delay before the next attempt once `attempts` unsuccessful attempts were made (>= 1). */
export function retryDelayMs(attempts: number, policy: RetryBackoffPolicy): number {
  const exponent = Math.min(Math.max(storedAttempts(attempts) - 1, 0), 40);
  // Clamped again for a policy built by hand (not through `resolveRetryBackoffPolicy`).
  return Math.min(
    policy.retryMaxDelayMs,
    MAX_RETRY_DELAY_MS,
    policy.retryBaseDelayMs * 2 ** exponent,
  );
}

/**
 * The retry fields after one more unsuccessful attempt of a row with `previous` attempts. A value
 * a host store returns that is not a non-negative integer counts as 0, so this never throws.
 */
export function nextRetryDeferral(
  previous: number | null | undefined,
  policy: RetryBackoffPolicy,
  nowMs: number = Date.now(),
): RetryDeferral {
  const attempts = storedAttempts(previous) + 1;
  if (attempts >= policy.maxAttempts) {
    return { attempts, nextAttemptAt: null, retryStatus: RETRY_STATUS.GAVE_UP };
  }
  return {
    attempts,
    nextAttemptAt: new Date(nowMs + retryDelayMs(attempts, policy)).toISOString(),
    retryStatus: null,
  };
}

/** What a row that resolved (processed, no longer uncertain) writes: no retry state left. */
export const CLEARED_RETRY_STATE: RetryDeferral = {
  attempts: null,
  nextAttemptAt: null,
  retryStatus: null,
};

/** `true` when any retry column is set (a write is needed to clear it). */
export function hasRetryState(row: RetryState): boolean {
  return row.attempts != null || row.nextAttemptAt != null || row.retryStatus != null;
}

/** `true` when a row may be selected now: not given up and `nextAttemptAt` missing or reached. */
export function isRetryDue(row: RetryState, nowMs: number = Date.now()): boolean {
  if (row.retryStatus != null) {
    return false;
  }
  if (!row.nextAttemptAt) {
    return true;
  }
  const dueMs = Date.parse(row.nextAttemptAt);
  return !Number.isFinite(dueMs) || dueMs <= nowMs;
}

/**
 * An operation that is no longer uncertain (not `unknown`, not a `submitted` create without
 * provider reference) keeps no retry state: a later uncertain episode starts a fresh schedule.
 * Returns the stored row; a concurrent write wins and is returned as read.
 */
export async function clearResolvedOperationRetryState(
  store: Pick<OperationStore, 'updateOperation' | 'findOperationById'>,
  operation: PaymentOperation,
): Promise<PaymentOperation> {
  const uncertain =
    operation.status === 'unknown' ||
    (operation.status === 'submitted' && !operation.providerReferenceId);
  if (uncertain || !hasRetryState(operation)) {
    return operation;
  }
  try {
    return await store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      ...CLEARED_RETRY_STATE,
    });
  } catch (error) {
    if (
      error instanceof PaymentReliabilityError &&
      error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT
    ) {
      return (await store.findOperationById(operation.operationId)) ?? operation;
    }
    throw error;
  }
}
