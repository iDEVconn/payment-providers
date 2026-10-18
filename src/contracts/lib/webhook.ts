import type { PaymentEnvironment } from './capabilities';
import type { EvidenceProcessingStatus, EvidenceVerificationStatus } from './evidence';

export type PaypalWebhookTransmissionHeaders = {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
};

export type VerifyWebhookRequest = {
  providerCode: string;
  accountRef: string;
  environment: PaymentEnvironment;
  webhookId: string;
  rawBody: string;
  headers: PaypalWebhookTransmissionHeaders;
};

export type VerifyWebhookResult = {
  verified: boolean;
  transmissionId: string;
  eventType: string | null;
  resourceId: string | null;
  unavailableReason?: string;
};

export type WebhookReceiptResponse = {
  evidenceId: string;
  duplicate: boolean;
  verificationStatus: EvidenceVerificationStatus;
  processingStatus: EvidenceProcessingStatus;
};

export type ReconcilePaymentOperationsRequest = {
  limit?: number;
  workerId?: string;
};

export type ReconcilePaymentOperationsResult = {
  examined: number;
  applied: number;
  retryableFailures: number;
  terminalFailures: number;
  noOps: number;
};
