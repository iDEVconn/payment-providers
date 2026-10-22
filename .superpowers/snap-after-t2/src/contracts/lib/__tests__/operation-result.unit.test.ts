import { describe, expect, it } from 'vitest';
import { PAYMENT_CAUSE_CODE, PAYMENT_RELIABILITY_ERROR, classifyPaymentFailure } from '../../index';

describe('classifyPaymentFailure', () => {
  it('maps missing credentials to configuration, not authentication or invalid input', () => {
    const failure = classifyPaymentFailure({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'Required configuration values are missing (PAYPAL_CLIENT_ID)',
    });
    expect(failure.category).toBe('configuration');
    expect(failure.causeCode).toBe(PAYMENT_CAUSE_CODE.CHECKOUT_CREDENTIALS_MISSING);
    expect(failure.diagnosticMessage).not.toMatch(/PAYPAL_CLIENT_ID|unconfigured-fake/);
    expect(failure.uncertain).toBe(false);
  });

  it('keeps a real provider authentication rejection distinct', () => {
    const failure = classifyPaymentFailure({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
      message: 'PayPal token request was rejected',
    });
    expect(failure.category).toBe('provider_authentication');
    expect(failure.causeCode).toBe(PAYMENT_CAUSE_CODE.PROVIDER_AUTH_REJECTED);
  });

  it('classifies execution blocks as policy failures, not unknown outcomes', () => {
    const failure = classifyPaymentFailure({
      code: 'EXECUTION_MODE_BLOCKED',
      message: 'Provider network calls are blocked',
    });
    expect(failure.category).toBe('execution_policy');
    expect(failure.uncertain).toBe(false);
    expect(failure.nextAction).toBe('contact_support');
  });

  it('classifies provider timeout as an unknown transport outcome', () => {
    const failure = classifyPaymentFailure({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal checkout create timed out',
      uncertain: true,
      retryable: true,
      providerAttempted: true,
    });
    expect(failure.uncertain).toBe(true);
    expect(failure.nextAction).toBe('check_status');
    expect(failure.causeCode).toBe(PAYMENT_CAUSE_CODE.PROVIDER_TIMEOUT);
  });
});
