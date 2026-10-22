import { describe, expect, it } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR } from '../../../contracts/index';
import {
  classifyWebhookEvidenceResume,
  isRecoverableEvidenceRow,
  isVerificationUnavailable,
} from '../webhook-evidence-resume';
import type { ProviderEvidenceRecord } from '../../../contracts/index';

function evidence(
  partial: Partial<ProviderEvidenceRecord> & Pick<ProviderEvidenceRecord, 'evidenceId'>,
): ProviderEvidenceRecord {
  return {
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox',
    evidenceKind: 'webhook',
    providerEventId: 'evt-1',
    relatedOperationId: null,
    receivedAt: '2026-01-01T00:00:00Z',
    verificationStatus: 'pending',
    payloadSha256: 'abc',
    processingStatus: 'pending',
    eventType: null,
    resourceId: null,
    errorCode: null,
    errorMessage: null,
    claimLeaseExpiresAt: null,
    claimWorkerId: null,
    processedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    rawPayload: '{}',
    ...partial,
  };
}

describe('webhook-evidence-resume', () => {
  it('classifies pending verification as resume', () => {
    expect(classifyWebhookEvidenceResume(evidence({ evidenceId: '1' }))).toBe('resume');
  });

  it('classifies verified processed without confirmed delivery as resume', () => {
    expect(
      classifyWebhookEvidenceResume(
        evidence({
          evidenceId: '2',
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'pending',
        }),
      ),
    ).toBe('resume');
  });

  it('classifies terminal signature rejection', () => {
    expect(
      classifyWebhookEvidenceResume(
        evidence({
          evidenceId: '3',
          verificationStatus: 'rejected',
          errorCode: PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
        }),
      ),
    ).toBe('terminal_rejected');
  });

  it('detects verification unavailable from failureKind', () => {
    expect(
      isVerificationUnavailable({
        verified: false,
        transmissionId: 't',
        eventType: null,
        resourceId: null,
        failureKind: 'verification_unavailable',
      }),
    ).toBe(true);
  });

  it('marks recoverable rows for pending verify and unconfirmed delivery', () => {
    expect(isRecoverableEvidenceRow(evidence({ evidenceId: '4' }))).toBe(true);
    expect(
      isRecoverableEvidenceRow(
        evidence({
          evidenceId: '5',
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'failed',
        }),
      ),
    ).toBe(true);
  });
});
