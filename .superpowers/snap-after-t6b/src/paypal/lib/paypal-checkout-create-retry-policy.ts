import {
  CHECKOUT_CREATE_DEFAULT_REQUEST_TIMEOUT_MS,
  CHECKOUT_CREATE_END_TO_END_HTTP_STEPS,
  CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS,
  evaluateCheckoutCreateExecutionClaimState,
  resolveCheckoutCreateEndToEndRequestTimeoutMs,
  type CheckoutProviderCreateExecutionClaimState,
} from '../../contracts/index';

export {
  CHECKOUT_CREATE_DEFAULT_REQUEST_TIMEOUT_MS as PAYPAL_DEFAULT_CHECKOUT_REQUEST_TIMEOUT_MS,
  CHECKOUT_CREATE_END_TO_END_HTTP_STEPS as PAYPAL_CHECKOUT_CREATE_END_TO_END_HTTP_STEPS,
  CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS as PAYPAL_CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS,
  resolveCheckoutCreateEndToEndRequestTimeoutMs as resolvePaypalCheckoutCreateEndToEndRequestTimeoutMs,
  type CheckoutProviderCreateExecutionClaimState as PaypalCheckoutCreateExecutionClaimState,
};

/** PayPal checkout order create idempotency window (PayPal-Request-Id), default 6 hours. */
export const PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type PaypalCheckoutCreateRetryEligibility = 'allowed' | 'expired' | 'unavailable';

export function evaluatePaypalCheckoutCreateRetryEligibility(
  firstProviderExecutionAt: string | null,
  nowMs: number = Date.now(),
): PaypalCheckoutCreateRetryEligibility {
  if (!firstProviderExecutionAt) {
    return 'unavailable';
  }
  const firstExecutionMs = Date.parse(firstProviderExecutionAt);
  if (Number.isNaN(firstExecutionMs)) {
    return 'unavailable';
  }
  const elapsedMs = nowMs - firstExecutionMs;
  if (elapsedMs < 0 || elapsedMs > PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS) {
    return 'expired';
  }
  return 'allowed';
}

export function evaluatePaypalCheckoutCreateExecutionClaimState(
  latestExecutionClaimAt: string | null,
  configuredRequestTimeoutMs: number | undefined,
  nowMs: number = Date.now(),
): CheckoutProviderCreateExecutionClaimState {
  return evaluateCheckoutCreateExecutionClaimState(
    latestExecutionClaimAt,
    configuredRequestTimeoutMs,
    nowMs,
  );
}
