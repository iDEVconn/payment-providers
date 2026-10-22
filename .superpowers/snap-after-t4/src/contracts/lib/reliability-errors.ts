import { sanitizePublicErrorMessage } from './public-error-sanitizer';

/** Stable RPC `detail` strings for transition_operation_v1 (Data API mapper). */
export const PAYMENT_RPC_TRANSITION_DETAIL = {
  EXECUTION_OWNER_MISMATCH: 'EXECUTION_OWNER_MISMATCH',
  PROVIDER_REFERENCE_BOUND: 'Provider reference is already bound to a different operation',
} as const;

export const PAYMENT_TRANSITION_REJECTION_REASON = {
  EXECUTION_OWNER_MISMATCH: 'execution_owner_mismatch',
  INVALID_TRANSITION: 'invalid_transition',
  PROVIDER_REFERENCE_BOUND: 'provider_reference_bound',
} as const;

export type PaymentTransitionRejectionReason =
  (typeof PAYMENT_TRANSITION_REJECTION_REASON)[keyof typeof PAYMENT_TRANSITION_REJECTION_REASON];

export const PAYMENT_RELIABILITY_ERROR = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OPERATION_CONFLICT: 'OPERATION_CONFLICT',
  TRANSITION_CONFLICT: 'TRANSITION_CONFLICT',
  TRANSITION_REJECTED: 'TRANSITION_REJECTED',
  EVIDENCE_DUPLICATE: 'EVIDENCE_DUPLICATE',
  VERIFICATION_UNAVAILABLE: 'VERIFICATION_UNAVAILABLE',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  PROVIDER_AUTH_FAILURE: 'PROVIDER_AUTH_FAILURE',
  PROVIDER_VALIDATION_REJECTION: 'PROVIDER_VALIDATION_REJECTION',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_STATE_CONFLICT: 'PROVIDER_STATE_CONFLICT',
  PROVIDER_RETRYABLE: 'PROVIDER_RETRYABLE',
  PROVIDER_UNCERTAIN: 'PROVIDER_UNCERTAIN',
  PROVIDER_TERMINAL_REJECTION: 'PROVIDER_TERMINAL_REJECTION',
  PROVIDER_ACTION_REQUIRED: 'PROVIDER_ACTION_REQUIRED',
  PERSISTENCE_FAILURE: 'PERSISTENCE_FAILURE',
  SUBSCRIPTION_PLAN_MISMATCH: 'SUBSCRIPTION_PLAN_MISMATCH',
} as const;

export type PaymentReliabilityErrorCode =
  (typeof PAYMENT_RELIABILITY_ERROR)[keyof typeof PAYMENT_RELIABILITY_ERROR];

/** Stored operation outcome for subscription-create failures (`unknown` | `failed`). */
export type PaymentReliabilityErrorPaymentOutcome = 'unknown' | 'failed';

export type PaymentReliabilityErrorOptions = {
  rejectionReason?: PaymentTransitionRejectionReason;
  operationId?: string;
  paymentOutcome?: PaymentReliabilityErrorPaymentOutcome;
  /** Provider diagnostic id (PayPal `debug_id`) for support and tracing. */
  providerDebugId?: string | null;
};

export class PaymentReliabilityError extends Error {
  readonly code: PaymentReliabilityErrorCode;
  readonly rejectionReason?: PaymentTransitionRejectionReason;
  readonly operationId?: string;
  readonly paymentOutcome?: PaymentReliabilityErrorPaymentOutcome;
  readonly providerDebugId?: string | null;

  constructor(
    code: PaymentReliabilityErrorCode,
    message: string,
    options?: PaymentReliabilityErrorOptions,
  ) {
    super(sanitizePublicErrorMessage(message, 'Payment reliability error'));
    this.name = 'PaymentReliabilityError';
    this.code = code;
    this.rejectionReason = options?.rejectionReason;
    this.operationId = options?.operationId;
    this.paymentOutcome = options?.paymentOutcome;
    this.providerDebugId = options?.providerDebugId;
  }
}
