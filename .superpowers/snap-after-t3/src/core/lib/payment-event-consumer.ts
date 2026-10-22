import type { ProviderEvidenceRecord } from '../../contracts/index';

export type VerifiedProcessedPaymentEvent = Pick<
  ProviderEvidenceRecord,
  | 'evidenceId'
  | 'providerCode'
  | 'accountRef'
  | 'applicationRef'
  | 'environment'
  | 'eventType'
  | 'resourceId'
  | 'relatedOperationId'
  | 'processingStatus'
  | 'verificationStatus'
>;

export interface PaymentEventConsumer {
  deliver(event: VerifiedProcessedPaymentEvent): Promise<void>;
}
