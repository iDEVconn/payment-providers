import type { PaymentEnvironment } from './capabilities';

export type ClaimPendingEvidenceInput = {
  limit: number;
  leaseMs: number;
  workerId: string;
  evidenceIds?: string[];
  environment?: PaymentEnvironment;
  providerCode?: string;
  accountRef?: string;
  /**
   * When `false`, rows whose only remaining work is consumer delivery (verified, processed,
   * delivery not confirmed) are not claimed. Default `true`. Recovery passes `false` when no
   * consumer is configured; a store must honour it, or those rows fill every batch and starve
   * newer work.
   */
  includeConsumerDelivery?: boolean;
};

export type RecoverPaymentReliabilityInput = {
  limit?: number;
  workerId: string;
  leaseMs?: number;
  environment?: PaymentEnvironment;
  providerCode?: string;
  accountRef?: string;
  evidenceIds?: string[];
};

export type RecoverPaymentReliabilityResult = {
  claimed: number;
  verified: number;
  processed: number;
  delivered: number;
  skipped: number;
  failed: number;
};

export type RecoverPaymentEvidenceInput = {
  evidenceId: string;
  workerId: string;
  leaseMs?: number;
  environment: PaymentEnvironment;
};

export type RecoverPaymentEvidenceResult = RecoverPaymentReliabilityResult & {
  evidenceId: string;
};

export type ListPaymentEvidenceForRecoveryInput = {
  environment: PaymentEnvironment;
  providerCode?: string;
  accountRef?: string;
  limit?: number;
  offset?: number;
  recoverableOnly?: boolean;
};

export type PaymentEvidenceAdminView = {
  evidenceId: string;
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  providerEventId: string;
  relatedOperationId: string | null;
  receivedAt: string;
  verificationStatus: string;
  processingStatus: string;
  consumerDeliveryStatus?: string;
  consumerDeliveredAt?: string | null;
  consumerDeliveryAttempts?: number;
  consumerDeliveryLastError?: string | null;
  eventType: string | null;
  resourceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  processedAt: string | null;
  updatedAt: string;
};

export type ListPaymentEvidenceForRecoveryResult = {
  items: PaymentEvidenceAdminView[];
  limit: number;
  offset: number;
};
