import { describe, expect, it } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import { assertTransitionAllowed, mapCheckoutWebhookEventToStatus } from '../transition-policy';

describe('transition policy', () => {
  it('maps supported checkout webhook events', () => {
    expect(mapCheckoutWebhookEventToStatus('PAYMENT.CAPTURE.COMPLETED')).toBe('succeeded');
    expect(mapCheckoutWebhookEventToStatus('PAYMENT.CAPTURE.REFUNDED')).toBeNull();
    expect(mapCheckoutWebhookEventToStatus('CHECKOUT.ORDER.APPROVED')).toBe('submitted');
    expect(mapCheckoutWebhookEventToStatus('UNKNOWN.EVENT')).toBeNull();
  });

  it('rejects terminal regression', () => {
    expect(() => assertTransitionAllowed('succeeded', 'failed')).toThrow(PaymentReliabilityError);
  });

  it('rejects duplicate success', () => {
    expect(() => assertTransitionAllowed('succeeded', 'succeeded')).toThrow(
      PaymentReliabilityError,
    );
  });
});
