import {
  isSubscriptionPaymentEvidenceEvent,
  isSubscriptionWebhookProviderRefreshEvent,
  mapSubscriptionWebhookEventToStatus,
} from './subscription-transition-policy';

/**
 * Evidence event types the pure subscription core reduces: subscription lifecycle events,
 * `BILLING.SUBSCRIPTION.UPDATED`, failed payments and subscription sales. Engine-internal (not
 * exported from the package root).
 */
export function isSubscriptionEvidenceEvent(eventType: string): boolean {
  return (
    mapSubscriptionWebhookEventToStatus(eventType) !== null ||
    isSubscriptionWebhookProviderRefreshEvent(eventType) ||
    isSubscriptionPaymentEvidenceEvent(eventType)
  );
}
