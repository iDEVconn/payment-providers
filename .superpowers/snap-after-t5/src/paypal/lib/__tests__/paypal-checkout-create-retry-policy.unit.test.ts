import { describe, expect, it } from 'vitest';
import {
  PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS,
  evaluatePaypalCheckoutCreateExecutionClaimState,
  evaluatePaypalCheckoutCreateRetryEligibility,
  resolvePaypalCheckoutCreateEndToEndRequestTimeoutMs,
} from '../paypal-checkout-create-retry-policy';

describe('evaluatePaypalCheckoutCreateRetryEligibility', () => {
  const firstExecutionAt = '2026-06-01T12:00:00.000Z';

  it('allows retry inside the six-hour window', () => {
    const nowMs = Date.parse(firstExecutionAt) + PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS - 1;
    expect(evaluatePaypalCheckoutCreateRetryEligibility(firstExecutionAt, nowMs)).toBe('allowed');
  });

  it('rejects retry after the window expires', () => {
    const nowMs = Date.parse(firstExecutionAt) + PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS + 1;
    expect(evaluatePaypalCheckoutCreateRetryEligibility(firstExecutionAt, nowMs)).toBe('expired');
  });

  it('rejects retry when the original execution time is unavailable', () => {
    expect(evaluatePaypalCheckoutCreateRetryEligibility(null)).toBe('unavailable');
  });
});

describe('evaluatePaypalCheckoutCreateExecutionClaimState', () => {
  it('delegates end-to-end timeout resolution to the shared checkout claim policy', () => {
    const claimAt = '2026-06-01T12:00:00.000Z';
    expect(resolvePaypalCheckoutCreateEndToEndRequestTimeoutMs(1_000)).toBe(2_000);
    expect(
      evaluatePaypalCheckoutCreateExecutionClaimState(claimAt, 1_000, Date.parse(claimAt) + 1_000),
    ).toBe('in_flight');
  });
});
