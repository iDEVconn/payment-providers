import { EXECUTION_MODE_BLOCKED, EXECUTION_MODE_MISMATCH } from './execution-mode';
import { PAYMENT_CAPABILITY_UNAVAILABLE } from './errors';
import { PAYMENT_RELIABILITY_ERROR } from './reliability-errors';

/** Outcome of one payment operation. Success is relative to operationKind. */
export type PaymentResultOutcome =
  | 'requires_action'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/** Guidance only. Callers must still enforce whether the action is safe. */
export type PaymentNextAction =
  | 'approve'
  | 'check_status'
  | 'resume_operation'
  | 'retry_later'
  | 'contact_support'
  | 'start_new_attempt'
  | 'none';

export type PaymentFailureCategory =
  | 'configuration'
  | 'capability_disabled'
  | 'execution_policy'
  | 'validation'
  | 'provider_authentication'
  | 'provider_rejection'
  | 'verification'
  | 'persistence'
  | 'transport';

export const PAYMENT_CAUSE_CODE = {
  CHECKOUT_CREDENTIALS_MISSING: 'CHECKOUT_CREDENTIALS_MISSING',
  CAPABILITY_DISABLED: 'CAPABILITY_DISABLED',
  EXECUTION_NOT_CONFIGURED: 'EXECUTION_NOT_CONFIGURED',
  EXECUTION_MISMATCH: 'EXECUTION_MISMATCH',
  PROVIDER_AUTH_REJECTED: 'PROVIDER_AUTH_REJECTED',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  RESPONSE_LOST: 'RESPONSE_LOST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VERIFICATION_UNAVAILABLE: 'VERIFICATION_UNAVAILABLE',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  PERSISTENCE_AFTER_SIDE_EFFECT: 'PERSISTENCE_AFTER_SIDE_EFFECT',
  TRANSPORT_BEFORE_PROVIDER: 'TRANSPORT_BEFORE_PROVIDER',
} as const;

export type PaymentCauseCode = (typeof PAYMENT_CAUSE_CODE)[keyof typeof PAYMENT_CAUSE_CODE];

/** Safe for consumer RPC mapping. Do not put secrets, env key lists, or strategy names here. */
export type NormalizedPaymentFailure = {
  code: string;
  category: PaymentFailureCategory;
  causeCode: PaymentCauseCode | string;
  nextAction: PaymentNextAction;
};

export type ClassifiedPaymentFailure = NormalizedPaymentFailure & {
  uncertain: boolean;
  retryable: boolean;
  /** Server diagnostic. Must not be shown as customer copy. */
  diagnosticMessage: string;
};

const CREDENTIAL_HINT =
  /credential|not configured|missing configuration|configuration values are missing/i;
const DISABLED_HINT = /disabled by configuration/i;

export function classifyPaymentFailure(input: {
  code: string | null | undefined;
  message?: string | null;
  causeCode?: string | null;
  uncertain?: boolean;
  retryable?: boolean;
  /** True when a provider request may already have been sent. */
  providerAttempted?: boolean;
}): ClassifiedPaymentFailure {
  const code = input.code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN;
  const diagnosticMessage = sanitizeDiagnostic(input.message);
  const hintedCause = input.causeCode ?? inferCause(code, diagnosticMessage);

  if (
    code === PAYMENT_CAPABILITY_UNAVAILABLE ||
    code === PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE
  ) {
    const disabled =
      DISABLED_HINT.test(diagnosticMessage) ||
      hintedCause === PAYMENT_CAUSE_CODE.CAPABILITY_DISABLED;
    return {
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      category: disabled ? 'capability_disabled' : 'configuration',
      causeCode: disabled
        ? PAYMENT_CAUSE_CODE.CAPABILITY_DISABLED
        : PAYMENT_CAUSE_CODE.CHECKOUT_CREDENTIALS_MISSING,
      nextAction: 'contact_support',
      uncertain: false,
      retryable: false,
      diagnosticMessage: disabled
        ? 'Payment capability is disabled'
        : 'Payment capability is unavailable',
    };
  }

  if (code === EXECUTION_MODE_BLOCKED || code === EXECUTION_MODE_MISMATCH) {
    return {
      code,
      category: 'execution_policy',
      causeCode:
        code === EXECUTION_MODE_MISMATCH
          ? PAYMENT_CAUSE_CODE.EXECUTION_MISMATCH
          : PAYMENT_CAUSE_CODE.EXECUTION_NOT_CONFIGURED,
      nextAction: 'contact_support',
      uncertain: false,
      retryable: false,
      diagnosticMessage: 'Payment execution is not configured for this operation',
    };
  }

  if (code === PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE) {
    return {
      code,
      category: 'provider_authentication',
      causeCode: PAYMENT_CAUSE_CODE.PROVIDER_AUTH_REJECTED,
      nextAction: 'contact_support',
      uncertain: false,
      retryable: false,
      diagnosticMessage: 'Payment provider rejected authentication',
    };
  }

  if (
    code === PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION
  ) {
    const customer = code === PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST;
    return {
      code,
      category: customer ? 'validation' : 'provider_rejection',
      causeCode: customer
        ? PAYMENT_CAUSE_CODE.VALIDATION_FAILED
        : PAYMENT_CAUSE_CODE.PROVIDER_REJECTED,
      nextAction: customer ? 'none' : 'start_new_attempt',
      uncertain: false,
      retryable: false,
      diagnosticMessage: customer
        ? 'Payment request failed validation'
        : 'Payment provider rejected the request',
    };
  }

  if (
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_STATE_CONFLICT
  ) {
    return {
      code,
      category: 'provider_rejection',
      causeCode: PAYMENT_CAUSE_CODE.PROVIDER_REJECTED,
      nextAction: 'start_new_attempt',
      uncertain: false,
      retryable: false,
      diagnosticMessage: 'Payment provider rejected the operation',
    };
  }

  if (code === PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE) {
    return {
      code,
      category: 'verification',
      causeCode: PAYMENT_CAUSE_CODE.VERIFICATION_UNAVAILABLE,
      nextAction: 'check_status',
      uncertain: true,
      retryable: true,
      diagnosticMessage: 'Payment verification is unavailable',
    };
  }

  if (code === PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED) {
    return {
      code,
      category: 'verification',
      causeCode: PAYMENT_CAUSE_CODE.VERIFICATION_REJECTED,
      nextAction: 'none',
      uncertain: false,
      retryable: false,
      diagnosticMessage: 'Payment verification was rejected',
    };
  }

  if (code === PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE) {
    const afterSideEffect = input.providerAttempted === true;
    return {
      code,
      category: 'persistence',
      causeCode: afterSideEffect
        ? PAYMENT_CAUSE_CODE.PERSISTENCE_AFTER_SIDE_EFFECT
        : PAYMENT_CAUSE_CODE.TRANSPORT_BEFORE_PROVIDER,
      nextAction: afterSideEffect ? 'check_status' : 'retry_later',
      uncertain: afterSideEffect,
      retryable: !afterSideEffect,
      diagnosticMessage: afterSideEffect
        ? 'Payment record could not be saved after the provider request'
        : 'Payment record could not be saved',
    };
  }

  if (
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE ||
    input.uncertain ||
    input.retryable
  ) {
    return {
      code:
        code === PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE
          ? code
          : PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      category: 'transport',
      causeCode: input.retryable
        ? PAYMENT_CAUSE_CODE.PROVIDER_TIMEOUT
        : PAYMENT_CAUSE_CODE.RESPONSE_LOST,
      nextAction: 'check_status',
      uncertain: true,
      retryable: true,
      diagnosticMessage: 'Payment provider outcome is not confirmed',
    };
  }

  return {
    code,
    category: 'transport',
    causeCode: hintedCause,
    nextAction: 'contact_support',
    uncertain: Boolean(input.uncertain),
    retryable: Boolean(input.retryable),
    diagnosticMessage: 'Payment operation could not be completed',
  };
}

function inferCause(code: string, message: string): string {
  if (CREDENTIAL_HINT.test(message)) {
    return PAYMENT_CAUSE_CODE.CHECKOUT_CREDENTIALS_MISSING;
  }
  if (DISABLED_HINT.test(message)) {
    return PAYMENT_CAUSE_CODE.CAPABILITY_DISABLED;
  }
  return code;
}

function sanitizeDiagnostic(message: string | null | undefined): string {
  const text = message?.trim() || 'Payment operation could not be completed';
  if (/unconfigured-fake|FakePaypal|simulation/i.test(text)) {
    return 'Payment capability is unavailable';
  }
  return text.slice(0, 300);
}

export function toPublicFailure(classified: ClassifiedPaymentFailure): NormalizedPaymentFailure {
  return {
    code: classified.code,
    category: classified.category,
    causeCode: classified.causeCode,
    nextAction: classified.nextAction,
  };
}
