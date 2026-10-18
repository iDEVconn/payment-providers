import { describe, expect, it } from 'vitest';
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
  });
});
