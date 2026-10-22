import type { PaymentEnvironment } from './capabilities';

export type ProviderEvidenceKind = 'webhook' | 'reconciliation';

export type EvidenceVerificationStatus = 'pending' | 'verified' | 'rejected';

export type EvidenceProcessingStatus =
  | 'pending'
  | 'processed'
  | 'unmatched'
  | 'unsupported'
  | 'failed';

export type ConsumerDeliveryStatus = 'pending' | 'confirmed' | 'failed';

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
  consumerDeliveryStatus?: ConsumerDeliveryStatus;
  consumerDeliveredAt?: string | null;
  consumerDeliveryAttempts?: number;
  consumerDeliveryLastError?: string | null;
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
