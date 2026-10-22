/**
 * Terminal marker of a row the engine stopped retrying (issues #8, #20). Stored in the nullable
 * `retryStatus` column of operations and evidence next to `attempts` and `nextAttemptAt`; `null`
 * means "still retried". The row keeps its own status (`unknown`, `unmatched`, `pending`, ...), so
 * a host that fixed the cause resets `retryStatus`, `attempts` and `nextAttemptAt` to `null` and
 * the row is picked up again. A store with a CHECK constraint on the column allows `'gave_up'`.
 */
export type RetryStatus = 'gave_up';

export const RETRY_STATUS = {
  GAVE_UP: 'gave_up',
} as const satisfies Record<string, RetryStatus>;

/**
 * Retry bookkeeping of an operation or an evidence row. All three are nullable columns; rows written
 * before 0.3 read as "never attempted" (`attempts` null or 0, `nextAttemptAt` null = due now).
 */
export type RetryState = {
  /** Unsuccessful reconciliation or recovery attempts so far. */
  attempts?: number | null;
  /** Not selected again before this time; `null` = due now. */
  nextAttemptAt?: string | null;
  /** `'gave_up'` after `maxAttempts`; never selected again until a host resets it. */
  retryStatus?: RetryStatus | null;
};
