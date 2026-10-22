import { describe, expect, it } from 'vitest';
import {
  PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS,
  evaluatePaypalSubscriptionCreateRetryEligibility,
} from '../paypal-subscription-create-retry-policy';

describe('evaluatePaypalSubscriptionCreateRetryEligibility', () => {
  const firstExecutionAt = '2026-01-01T00:00:00.000Z';

  it('allows retry inside the 72-hour window', () => {
    const nowMs =
      Date.parse(firstExecutionAt) + PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS - 1;
    expect(evaluatePaypalSubscriptionCreateRetryEligibility(firstExecutionAt, nowMs)).toBe(
      'allowed',
    );
  });

  it('blocks retry after the window expires', () => {
    const nowMs =
      Date.parse(firstExecutionAt) + PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS + 1;
    expect(evaluatePaypalSubscriptionCreateRetryEligibility(firstExecutionAt, nowMs)).toBe(
      'expired',
    );
  });

  it('blocks retry when the first execution anchor is missing', () => {
    expect(evaluatePaypalSubscriptionCreateRetryEligibility(null)).toBe('unavailable');
  });
});
