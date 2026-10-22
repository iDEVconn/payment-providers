import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
  type EvidenceVerificationStatus,
  type PaymentOperationStatus,
} from '../../contracts/index';

const invalidTransitionRejection = (message: string) =>
  new PaymentReliabilityError(PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED, message, {
    rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION,
  });

const TERMINAL: ReadonlySet<PaymentOperationStatus> = new Set(['succeeded', 'failed']);

export function assertVerifiedEvidence(verificationStatus: EvidenceVerificationStatus): void {
  if (verificationStatus !== 'verified') {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
      'Operation transitions require verified provider evidence',
    );
  }
}

export function assertTransitionAllowed(
  currentStatus: PaymentOperationStatus,
  nextStatus: PaymentOperationStatus,
): void {
  if (currentStatus === nextStatus) {
    if (currentStatus === 'succeeded') {
      throw invalidTransitionRejection('Duplicate success transition is not allowed');
    }
    return;
  }

  if (TERMINAL.has(currentStatus)) {
    throw invalidTransitionRejection(
      `Terminal operation status "${currentStatus}" cannot regress to "${nextStatus}"`,
    );
  }

  const allowed: Record<PaymentOperationStatus, PaymentOperationStatus[]> = {
    prepared: ['submitted', 'unknown', 'succeeded', 'failed'],
    submitted: ['unknown', 'succeeded', 'failed'],
    unknown: ['succeeded', 'failed', 'unknown', 'submitted'],
    succeeded: [],
    failed: [],
  };

  if (!allowed[currentStatus].includes(nextStatus)) {
    throw invalidTransitionRejection(
      `Transition from "${currentStatus}" to "${nextStatus}" is not allowed`,
    );
  }
}

export function mapCheckoutWebhookEventToStatus(eventType: string): PaymentOperationStatus | null {
  switch (eventType) {
    case 'CHECKOUT.ORDER.APPROVED':
      return 'submitted';
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'succeeded';
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      return 'failed';
    case 'PAYMENT.CAPTURE.REFUNDED':
      return null;
    default:
      return null;
  }
}

export function mapWebhookEventToOperationKind(
  eventType: string,
): 'checkout' | 'capture' | 'refund' | null {
  switch (eventType) {
    case 'CHECKOUT.ORDER.APPROVED':
      return 'checkout';
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      return 'capture';
    case 'PAYMENT.CAPTURE.REFUNDED':
      return 'refund';
    default:
      return null;
  }
}
