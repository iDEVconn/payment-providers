import type { ProviderEvidenceRecord } from '../../contracts/index';

/**
 * What a consumer receives: the evidence identity and outcome, without the stored row internals.
 * `rawPayload` (the provider body) is present only when the host sets `includeRawPayload`.
 */
export type VerifiedProcessedPaymentEvent = Pick<
  ProviderEvidenceRecord,
  | 'evidenceId'
  | 'providerCode'
  | 'accountRef'
  | 'applicationRef'
  | 'environment'
  | 'providerEventId'
  | 'eventType'
  | 'resourceId'
  | 'relatedOperationId'
  | 'processingStatus'
  | 'verificationStatus'
> & {
  rawPayload?: string;
};

/**
 * Delivery is at-least-once: an event can arrive again after a failed acknowledgement write or a
 * lost lease, so `deliver` must be idempotent (dedupe on `providerEventId`). Throwing counts as a
 * failed attempt; after `maxConsumerDeliveryAttempts` the row is `failed_terminal`.
 */
export interface PaymentEventConsumer {
  deliver(event: VerifiedProcessedPaymentEvent): Promise<void>;
}

/** Builds the narrowed consumer event from a stored evidence row. */
export function toVerifiedProcessedPaymentEvent(
  evidence: ProviderEvidenceRecord,
  options: { includeRawPayload?: boolean } = {},
): VerifiedProcessedPaymentEvent {
  return {
    evidenceId: evidence.evidenceId,
    providerCode: evidence.providerCode,
    accountRef: evidence.accountRef,
    applicationRef: evidence.applicationRef,
    environment: evidence.environment,
    providerEventId: evidence.providerEventId,
    eventType: evidence.eventType,
    resourceId: evidence.resourceId,
    relatedOperationId: evidence.relatedOperationId,
    processingStatus: evidence.processingStatus,
    verificationStatus: evidence.verificationStatus,
    ...(options.includeRawPayload ? { rawPayload: evidence.rawPayload } : {}),
  };
}
