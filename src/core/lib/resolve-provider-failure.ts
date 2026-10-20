import {
  EXECUTION_MODE_BLOCKED,
  EXECUTION_MODE_MISMATCH,
  PAYMENT_CAPABILITY_UNAVAILABLE,
  PAYMENT_RELIABILITY_ERROR,
  PaymentCapabilityError,
  PaymentReliabilityError,
  rehydratePaymentCapabilityError,
} from '../../contracts/index';
import { sanitizePublicErrorMessage } from './public-error-sanitizer';

export type ResolvedProviderFailure = {
  code: string;
  message: string;
  uncertain: boolean;
  retryable: boolean;
  providerDebugId: string | null;
};

function isUnconfiguredFakePaymentError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const details = error['details'];
  return isRecord(details) && details['simulation'] === 'unconfigured-fake';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nestedRecord(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) {
    return null;
  }
  if (typeof error['getError'] === 'function') {
    const nested = error['getError']();
    return isRecord(nested) ? nested : null;
  }
  if (isRecord(error['message'])) {
    return error['message'];
  }
  if (isRecord(error['error'])) {
    return error['error'];
  }
  return error;
}

export function isTerminalPreProviderFailureCode(code: string | undefined): boolean {
  return (
    code === PAYMENT_CAPABILITY_UNAVAILABLE ||
    code === PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE ||
    code === EXECUTION_MODE_BLOCKED ||
    code === EXECUTION_MODE_MISMATCH ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE
  );
}

export function resolveProviderFailure(error: unknown): ResolvedProviderFailure {
  const capability =
    error instanceof PaymentCapabilityError ? error : rehydratePaymentCapabilityError(error);
  if (capability) {
    return {
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      message: capability.unavailableReason,
      uncertain: false,
      retryable: false,
      providerDebugId: null,
    };
  }

  if (isUnconfiguredFakePaymentError(error)) {
    return {
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      message: 'Payment capability is unavailable',
      uncertain: false,
      retryable: false,
      providerDebugId: null,
    };
  }

  const nested = nestedRecord(error);
  const code =
    error instanceof PaymentReliabilityError
      ? error.code
      : ((nested ? readString(nested, 'code') : null) ??
        (isRecord(error) ? readString(error, 'code') : null));
  const rawMessage =
    error instanceof Error
      ? error.message
      : ((nested ? readString(nested, 'message') : null) ??
        (isRecord(error) && typeof error['message'] === 'string' ? error['message'] : null) ??
        'Provider submission failed');
  const message = sanitizePublicErrorMessage(rawMessage, 'Provider submission failed');
  const retryableFromError =
    isRecord(error) && error['retryable'] === true ? true : undefined;
  const uncertain =
    nested?.['uncertain'] === true || (isRecord(error) && error['uncertain'] === true);
  const retryable = retryableFromError === true || nested?.['retryable'] === true;
  const providerDebugId =
    (nested ? readString(nested, 'providerDebugId') : null) ??
    (isRecord(error) ? readString(error, 'providerDebugId') : null);

  return {
    code: code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
    message,
    uncertain,
    retryable,
    providerDebugId,
  };
}
