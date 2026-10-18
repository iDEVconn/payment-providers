import { describe, expect, it } from 'vitest';
import { PaymentCapabilityError } from '../../../contracts/index';
import { assertCapabilityReady } from '../assert-capability-ready';
import { evaluateCapabilities } from '../evaluate-capabilities';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox' as const,
  applicationRef: 'edc',
};

describe('assertCapabilityReady', () => {
  it('throws CAPABILITY_UNAVAILABLE for payout before any provider work', () => {
    const capabilities = evaluateCapabilities((_key) => undefined, context);
    expect(() => assertCapabilityReady(capabilities, 'payout')).toThrow(PaymentCapabilityError);
    try {
      assertCapabilityReady(capabilities, 'payout');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        capability: 'payout',
      });
    }
  });
});
