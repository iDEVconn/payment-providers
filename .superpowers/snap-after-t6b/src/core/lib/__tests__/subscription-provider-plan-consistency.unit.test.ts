import { describe, expect, it } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../../contracts/index';
import {
  assertSubscriptionProviderPlanSnapshotConsistent,
  isSubscriptionProviderPlanMismatchError,
} from '../subscription-provider-plan-consistency';

describe('subscription provider plan consistency', () => {
  it('allows matching stored and snapshot plan ids', () => {
    expect(() =>
      assertSubscriptionProviderPlanSnapshotConsistent(
        { providerPlanId: 'PLAN-A' },
        { providerPlanId: 'PLAN-A' },
      ),
    ).not.toThrow();
  });

  it('rejects mismatched plan ids', () => {
    expect(() =>
      assertSubscriptionProviderPlanSnapshotConsistent(
        { providerPlanId: 'PLAN-A' },
        { providerPlanId: 'PLAN-B' },
      ),
    ).toThrow(
      expect.objectContaining({
        code: PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
      }),
    );
  });

  it('ignores missing snapshot plan id', () => {
    expect(() =>
      assertSubscriptionProviderPlanSnapshotConsistent(
        { providerPlanId: 'PLAN-A' },
        { providerPlanId: null },
      ),
    ).not.toThrow();
  });

  it('identifies plan mismatch errors', () => {
    const error = new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
      'mismatch',
    );
    expect(isSubscriptionProviderPlanMismatchError(error)).toBe(true);
  });
});
