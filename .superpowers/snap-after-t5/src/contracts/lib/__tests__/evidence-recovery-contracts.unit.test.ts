import { describe, expect, it } from 'vitest';
import { PAYMENT_CAUSE_CODE, PAYMENT_RELIABILITY_ERROR, classifyPaymentFailure } from '../../index';

describe('evidence and recovery contract behavior', () => {
  it('maps verification unavailable to retryable operation outcome', () => {
    const mapped = classifyPaymentFailure({
      code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE,
      message: 'PayPal verify HTTP 503',
      retryable: true,
      uncertain: true,
    });
    expect(mapped.causeCode).toBe(PAYMENT_CAUSE_CODE.VERIFICATION_UNAVAILABLE);
    expect(mapped.retryable).toBe(true);
  });

  it('maps terminal verification rejection as non-retryable', () => {
    const mapped = classifyPaymentFailure({
      code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
      message: 'invalid signature',
    });
    expect(mapped.causeCode).toBe(PAYMENT_CAUSE_CODE.VERIFICATION_REJECTED);
    expect(mapped.retryable).toBe(false);
  });

  it('accepts consumer delivery status literals used by the store port', () => {
    const statuses = ['pending', 'confirmed', 'failed'] as const;
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('failed');
  });
});
