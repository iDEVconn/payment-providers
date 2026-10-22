import {
  PAYMENT_RELIABILITY_ERROR,
  type ProviderEvidenceRecord,
  type VerifyWebhookResult,
} from '../../contracts/index';

export type WebhookEvidenceResumeAction =
  | 'insert_new'
  | 'resume'
  | 'ack_duplicate'
  | 'terminal_rejected';

export function classifyWebhookEvidenceResume(
  evidence: ProviderEvidenceRecord,
): WebhookEvidenceResumeAction {
  if (evidence.verificationStatus === 'rejected') {
    if (evidence.errorCode === PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE) {
      return 'resume';
    }
    return 'terminal_rejected';
  }

  if (evidence.verificationStatus === 'verified') {
    if (evidence.processingStatus === 'processed') {
      if (isConsumerDeliveryComplete(evidence)) {
        return 'ack_duplicate';
      }
      return 'resume';
    }
    if (evidence.processingStatus === 'pending' || evidence.processingStatus === 'unmatched') {
      return 'resume';
    }
    if (evidence.processingStatus === 'unsupported') {
      return 'ack_duplicate';
    }
  }

  if (evidence.verificationStatus === 'pending') {
    return 'resume';
  }

  return 'ack_duplicate';
}

export function isConsumerDeliveryComplete(evidence: ProviderEvidenceRecord): boolean {
  if (evidence.consumerDeliveryStatus === undefined) {
    return true;
  }
  return evidence.consumerDeliveryStatus === 'confirmed';
}

export function verificationFailureKind(
  verification: VerifyWebhookResult,
): NonNullable<VerifyWebhookResult['failureKind']> {
  if (verification.failureKind) {
    return verification.failureKind;
  }
  return verification.unavailableReason ? 'signature_rejected' : 'signature_rejected';
}

export function isVerificationUnavailable(verification: VerifyWebhookResult): boolean {
  return (
    !verification.verified && verificationFailureKind(verification) === 'verification_unavailable'
  );
}

export function isRecoverableEvidenceRow(evidence: ProviderEvidenceRecord): boolean {
  if (evidence.verificationStatus === 'pending') {
    return true;
  }
  if (evidence.verificationStatus === 'verified' && evidence.processingStatus === 'pending') {
    return true;
  }
  if (evidence.verificationStatus === 'verified' && evidence.processingStatus === 'processed') {
    return evidence.consumerDeliveryStatus !== 'confirmed';
  }
  if (evidence.verificationStatus === 'verified' && evidence.processingStatus === 'unmatched') {
    return true;
  }
  return false;
}
