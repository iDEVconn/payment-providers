/** PayPal subscription create idempotency window (PayPal-Request-Id), default 72 hours. */
export const PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS = 72 * 60 * 60 * 1000;

export type PaypalSubscriptionCreateRetryEligibility = 'allowed' | 'expired' | 'unavailable';

export function evaluatePaypalSubscriptionCreateRetryEligibility(
  firstProviderExecutionAt: string | null,
  nowMs: number = Date.now(),
): PaypalSubscriptionCreateRetryEligibility {
  if (!firstProviderExecutionAt) {
    return 'unavailable';
  }
  const firstExecutionMs = Date.parse(firstProviderExecutionAt);
  if (Number.isNaN(firstExecutionMs)) {
    return 'unavailable';
  }
  const elapsedMs = nowMs - firstExecutionMs;
  if (elapsedMs < 0 || elapsedMs > PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS) {
    return 'expired';
  }
  return 'allowed';
}
