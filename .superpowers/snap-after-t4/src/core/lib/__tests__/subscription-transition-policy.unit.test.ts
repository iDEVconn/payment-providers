import { describe, expect, it } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
} from '../../../contracts/index';
import {
  assertSubscriptionTransitionAllowed,
  mapPlanWebhookEventToStatus,
  mapSubscriptionWebhookEventToStatus,
  subscriptionStatusToOperationStatus,
} from '../subscription-transition-policy';

describe('subscription-transition-policy', () => {
  it('maps subscription lifecycle webhooks', () => {
    expect(mapSubscriptionWebhookEventToStatus('BILLING.SUBSCRIPTION.ACTIVATED')).toBe('active');
    expect(mapSubscriptionWebhookEventToStatus('BILLING.SUBSCRIPTION.CANCELLED')).toBe('cancelled');
    expect(mapPlanWebhookEventToStatus('BILLING.PLAN.DEACTIVATED')).toBe('inactive');
  });

  it('maps subscription statuses to execution statuses', () => {
    expect(subscriptionStatusToOperationStatus('active')).toBe('succeeded');
    expect(subscriptionStatusToOperationStatus('approval_pending')).toBe('submitted');
    expect(subscriptionStatusToOperationStatus('cancelled')).toBe('failed');
  });

  it('blocks cancelled subscriptions from reactivating', () => {
    expect(() => assertSubscriptionTransitionAllowed('cancelled', 'active')).toThrow();
    expect(() => assertSubscriptionTransitionAllowed('cancelled', 'suspended')).toThrow();
  });

  it('blocks active subscriptions from regressing to approval_pending', () => {
    expect(() => assertSubscriptionTransitionAllowed('active', 'approval_pending')).toThrow();
  });

  it('blocks approved and suspended subscriptions from regressing to approval_pending', () => {
    expect(() => assertSubscriptionTransitionAllowed('approved', 'approval_pending')).toThrow();
    expect(() => assertSubscriptionTransitionAllowed('suspended', 'approval_pending')).toThrow();
    expect(() => assertSubscriptionTransitionAllowed('unknown', 'approval_pending')).not.toThrow();
  });

  it('allows active and suspended to toggle', () => {
    expect(() => assertSubscriptionTransitionAllowed('active', 'suspended')).not.toThrow();
    expect(() => assertSubscriptionTransitionAllowed('suspended', 'active')).not.toThrow();
  });
});

describe('subscription-transition-policy errors', () => {
  it.each([
    ['cancelled', 'active'],
    ['active', 'approval_pending'],
  ] as const)('throws a typed PaymentReliabilityError for %s -> %s', (current, next) => {
    let thrown: unknown;
    try {
      assertSubscriptionTransitionAllowed(current, next);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaymentReliabilityError);
    expect(thrown).toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
      rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION,
    });
  });
});
