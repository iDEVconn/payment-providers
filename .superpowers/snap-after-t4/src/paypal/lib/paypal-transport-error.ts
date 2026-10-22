import { PAYMENT_RELIABILITY_ERROR } from '../../contracts/index';
import { sanitizePublicErrorMessage } from '../../core/lib/public-error-sanitizer';
import { PaypalWebhookVerificationHttpError } from './paypal-webhook-verification-http';

export type PaypalTransportContext =
  | 'oauth'
  | 'webhook_verify'
  | 'orders'
  | 'payout'
  | 'subscription'
  | 'seller_onboarding';

export type SanitizedProviderTransportError = {
  code: string;
  message: string;
  retryable: boolean;
  uncertain: boolean;
};

const NETWORK_MESSAGE: Record<PaypalTransportContext, string> = {
  oauth: 'PayPal OAuth request failed due to a network error',
  webhook_verify: 'PayPal webhook verification failed due to a network error',
  orders: 'PayPal API request failed due to a network error',
  payout: 'PayPal payout request failed due to a network error',
  subscription: 'PayPal subscription request failed due to a network error',
  seller_onboarding: 'PayPal seller onboarding request failed due to a network error',
};

const TIMEOUT_MESSAGE: Record<PaypalTransportContext, string> = {
  oauth: 'PayPal OAuth request timed out',
  webhook_verify: 'PayPal webhook verification timed out',
  orders: 'PayPal HTTP request timed out',
  payout: 'PayPal payout HTTP request timed out',
  subscription: 'PayPal subscription HTTP request timed out',
  seller_onboarding: 'PayPal seller onboarding HTTP request timed out',
};

export { messageContainsSensitiveContent, sanitizePublicErrorMessage } from '../../core/lib/public-error-sanitizer';

export function sanitizePaypalTransportFailure(
  context: PaypalTransportContext,
  error: unknown,
): SanitizedProviderTransportError {
  if (error instanceof PaypalWebhookVerificationHttpError) {
    return {
      code:
        error.kind === 'verification_unavailable'
          ? PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE
          : PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
      message:
        error.kind === 'verification_unavailable'
          ? 'PayPal webhook verification is temporarily unavailable'
          : 'PayPal webhook verification request was rejected',
      retryable: error.kind === 'verification_unavailable',
      uncertain: error.kind === 'verification_unavailable',
    };
  }

  if (isStructuredProviderError(error)) {
    return {
      code: readString(error, 'code') ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: sanitizePublicErrorMessage(
        readString(error, 'message') ?? '',
        NETWORK_MESSAGE[context],
      ),
      retryable: error.retryable === true,
      uncertain: error.uncertain === true,
    };
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: TIMEOUT_MESSAGE[context],
      retryable: true,
      uncertain: true,
    };
  }

  return {
    code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
    message: NETWORK_MESSAGE[context],
    retryable: true,
    uncertain: true,
  };
}

function isStructuredProviderError(
  error: unknown,
): error is { code?: string; message?: string; retryable?: boolean; uncertain?: boolean } {
  return (
    typeof error === 'object' &&
    error !== null &&
    !(error instanceof Error) &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function readString(
  error: { code?: string; message?: string },
  key: 'code' | 'message',
): string | null {
  const value = error[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
