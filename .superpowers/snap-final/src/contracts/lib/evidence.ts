import type { PaymentEnvironment } from './capabilities';
import type { RetryStatus } from './retry';

export type ProviderEvidenceKind = 'webhook' | 'reconciliation';

export type EvidenceVerificationStatus = 'pending' | 'verified' | 'rejected';

export type EvidenceProcessingStatus =
  | 'pending'
  | 'processed'
  | 'unmatched'
  | 'unsupported'
  | 'failed';

/**
 * Consumer delivery of a processed event. `failed` is retried by recovery; `failed_terminal` means
 * the attempt cap was reached and recovery no longer claims the row. To retry it, a host sets
 * `consumerDeliveryStatus: 'failed'` AND lowers `consumerDeliveryAttempts` below
 * `maxConsumerDeliveryAttempts` (e.g. to 0): while the count is still at the cap, recovery marks
 * the row `failed_terminal` again without delivering it.
 */
export type ConsumerDeliveryStatus = 'pending' | 'confirmed' | 'failed' | 'failed_terminal';

export type ProviderEvidence = {
  evidenceId: string;
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  evidenceKind: ProviderEvidenceKind;
  providerEventId: string;
  relatedOperationId: string | null;
  receivedAt: string;
  verificationStatus: EvidenceVerificationStatus;
  payloadSha256: string;
  processingStatus: EvidenceProcessingStatus;
  eventType: string | null;
  resourceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  claimLeaseExpiresAt: string | null;
  claimWorkerId: string | null;
  processedAt: string | null;
  /*
   * Consumer delivery fields. A store MUST persist all four and return them as written: a row
   * read back without `consumerDeliveryStatus` counts as delivered (legacy rows), so a store that
   * drops them silently skips every consumer delivery (issue #24).
   */
  consumerDeliveryStatus?: ConsumerDeliveryStatus;
  consumerDeliveredAt?: string | null;
  /** Failed delivery attempts so far; recovery stops at `maxConsumerDeliveryAttempts`. */
  consumerDeliveryAttempts?: number;
  consumerDeliveryLastError?: string | null;
  /*
   * Recovery and reconciliation retry bookkeeping (issues #8, #20): unsuccessful attempts to
   * process the row, the earliest time it is selected again, and `'gave_up'` after the attempt
   * cap. Consumer delivery keeps its own counter and terminal status above.
   */
  attempts?: number | null;
  nextAttemptAt?: string | null;
  retryStatus?: RetryStatus | null;
  createdAt: string;
  updatedAt: string;
};

/** Stored server-side only; never returned through general client RPCs. */
export type ProviderEvidenceRecord = ProviderEvidence & {
  rawPayload: string;
};

export type InsertProviderEvidenceInput = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  evidenceKind: ProviderEvidenceKind;
  providerEventId: string;
  rawPayload: string;
  payloadSha256: string;
  eventType?: string | null;
  resourceId?: string | null;
};

export type UpdateProviderEvidenceInput = {
  evidenceId: string;
  verificationStatus?: EvidenceVerificationStatus;
  processingStatus?: EvidenceProcessingStatus;
  relatedOperationId?: string | null;
  eventType?: string | null;
  resourceId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  claimLeaseExpiresAt?: string | null;
  claimWorkerId?: string | null;
  processedAt?: string | null;
  consumerDeliveryStatus?: ConsumerDeliveryStatus;
  consumerDeliveredAt?: string | null;
  consumerDeliveryAttempts?: number;
  consumerDeliveryLastError?: string | null;
  attempts?: number | null;
  nextAttemptAt?: string | null;
  retryStatus?: RetryStatus | null;
};

export type ReconciliationAttempt = {
  attemptId: string;
  evidenceId: string;
  operationId: string | null;
  outcome: 'applied' | 'retryable_failure' | 'terminal_failure' | 'no_op';
  resultCode: string | null;
  resultMessage: string | null;
  createdAt: string;
};

export type InsertReconciliationAttemptInput = {
  evidenceId: string;
  operationId?: string | null;
  outcome: ReconciliationAttempt['outcome'];
  resultCode?: string | null;
  resultMessage?: string | null;
};
