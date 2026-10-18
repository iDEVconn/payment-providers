import {
  PAYMENT_CAPABILITY_UNAVAILABLE,
  PAYMENT_RELIABILITY_ERROR,
  PaymentCapabilityError,
  PaymentReliabilityError,
  rehydratePaymentCapabilityError,
} from '../../contracts/index';

export type ResolvedProviderFailure = {
  code: string;
  message: string;
  uncertain: boolean;
  retryable: boolean;
  providerDebugId: string | null;
};

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
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION ||
    code === PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION
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

  const nested = nestedRecord(error);
  const code =
    error instanceof PaymentReliabilityError
      ? error.code
      : ((nested ? readString(nested, 'code') : null) ??
        (isRecord(error) ? readString(error, 'code') : null));
  const message =
    error instanceof Error
      ? error.message
      : ((nested ? readString(nested, 'message') : null) ??
        (isRecord(error) && typeof error['message'] === 'string' ? error['message'] : null) ??
        'Provider submission failed');
  const uncertain =
    nested?.['uncertain'] === true || (isRecord(error) && error['uncertain'] === true);
  const retryable =
    nested?.['retryable'] === true || (isRecord(error) && error['retryable'] === true);
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
