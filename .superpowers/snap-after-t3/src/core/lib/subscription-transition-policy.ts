import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
} from '../../contracts/index';
import type {
  PaymentOperationStatus,
  PlanStatus,
  ProductStatus,
  SubscriptionStatus,
} from '../../contracts/index';
import {
  evaluateSubscriptionStateOrdering,
  isSubscriptionStatusTransitionAllowed,
  isTerminalSubscriptionStatus,
  parseProviderTimestamp,
} from '../../subscription-core/lib/subscription-status-rules';

// Status mapping and transition rules live in the pure subscription core; re-exported unchanged.
export {
  isSubscriptionPaymentEvidenceEvent,
  isSubscriptionWebhookProviderRefreshEvent,
  mapPaypalSubscriptionStatus,
  mapSubscriptionWebhookEventToStatus,
  resolveSubscriptionStatusTransition,
} from '../../subscription-core/lib/subscription-status-rules';

export const SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX = 'subscription-provider-state-at:';

export type SubscriptionStateApplySource =
  | 'webhook'
  | 'reconcile_provider'
  | 'reconcile_event'
  | 'provider_mutation';

export function parseSubscriptionResourceStateTimestamp(
  rawPayload: string | null | undefined,
): string | null {
  if (!rawPayload) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawPayload) as {
      resource?: { update_time?: unknown; create_time?: unknown };
    };
    return parseProviderTimestamp(parsed.resource?.update_time ?? parsed.resource?.create_time);
  } catch {
    return null;
  }
}

export function formatSubscriptionProviderStateWatermark(isoTimestamp: string): string {
  return `${SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX}${isoTimestamp}`;
}

export function isLegacySubscriptionProviderStateTransactionId(
  providerTransactionId: string | null | undefined,
): boolean {
  return Boolean(providerTransactionId?.startsWith(SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX));
}

export function readSubscriptionProviderStateWatermark(operation: {
  providerSubscriptionStateAt: string | null;
  providerTransactionId: string | null;
}): string | null {
  if (operation.providerSubscriptionStateAt) {
    return operation.providerSubscriptionStateAt;
  }
  const value = operation.providerTransactionId;
  if (!value?.startsWith(SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX)) {
    return null;
  }
  return value.slice(SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX.length);
}

export function resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist(operation: {
  providerTransactionId: string | null;
}): string | null | undefined {
  if (isLegacySubscriptionProviderStateTransactionId(operation.providerTransactionId)) {
    return null;
  }
  return undefined;
}

export type SubscriptionProviderStateOrderingDecision =
  | { action: 'apply'; providerStateWatermark: string | null }
  | { action: 'noop'; reason: 'stale' | 'equal_conflict' | 'missing_timestamp' };

export function evaluateSubscriptionProviderStateOrdering(input: {
  operation: {
    subscriptionStatus: SubscriptionStatus | null;
    providerSubscriptionStateAt: string | null;
    providerTransactionId: string | null;
  };
  desiredStatus: SubscriptionStatus;
  providerStateTimestamp: string | null;
  applySource: SubscriptionStateApplySource;
}): SubscriptionProviderStateOrderingDecision {
  if (input.applySource === 'provider_mutation' || input.applySource === 'reconcile_provider') {
    return { action: 'apply', providerStateWatermark: null };
  }

  const ordering = evaluateSubscriptionStateOrdering({
    currentStatus: input.operation.subscriptionStatus,
    storedStateAt: readSubscriptionProviderStateWatermark(input.operation),
    desiredStatus: input.desiredStatus,
    incomingStateAt: input.providerStateTimestamp,
    authoritative: false,
  });
  if (ordering.action === 'noop') {
    return ordering;
  }
  return { action: 'apply', providerStateWatermark: ordering.stateAt };
}

export function mapPaypalProductStatus(): ProductStatus {
  return 'created';
}

export function mapPaypalPlanStatus(status: string): PlanStatus {
  switch (status.toUpperCase()) {
    case 'CREATED':
      return 'created';
    case 'ACTIVE':
      return 'active';
    case 'INACTIVE':
      return 'inactive';
    default:
      return 'unknown';
  }
}

export function mapPlanWebhookEventToStatus(eventType: string): PlanStatus | null {
  switch (eventType) {
    case 'BILLING.PLAN.ACTIVATED':
      return 'active';
    case 'BILLING.PLAN.DEACTIVATED':
      return 'inactive';
    default:
      return null;
  }
}

export function mapSubscriptionWebhookEventToOperationKind(
  eventType: string,
): 'subscription' | 'billing_plan' | null {
  if (eventType.startsWith('BILLING.SUBSCRIPTION.')) {
    return 'subscription';
  }
  if (eventType === 'BILLING.PLAN.ACTIVATED' || eventType === 'BILLING.PLAN.DEACTIVATED') {
    return 'billing_plan';
  }
  return null;
}

export function subscriptionStatusToOperationStatus(
  status: SubscriptionStatus,
): PaymentOperationStatus {
  if (status === 'active' || status === 'approved') {
    return 'succeeded';
  }
  if (status === 'cancelled' || status === 'expired') {
    return 'failed';
  }
  if (status === 'unknown') {
    return 'unknown';
  }
  return 'submitted';
}

export function planStatusToOperationStatus(status: PlanStatus): PaymentOperationStatus {
  if (status === 'active') {
    return 'succeeded';
  }
  if (status === 'inactive') {
    return 'failed';
  }
  if (status === 'unknown') {
    return 'unknown';
  }
  return 'submitted';
}

export function assertSubscriptionTransitionAllowed(
  current: SubscriptionStatus,
  next: SubscriptionStatus,
): void {
  if (isSubscriptionStatusTransitionAllowed(current, next)) {
    return;
  }
  if (isTerminalSubscriptionStatus(current)) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
      `Terminal subscription status "${current}" cannot transition to "${next}"`,
      { rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION },
    );
  }
  throw new PaymentReliabilityError(
    PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
    `Subscription status "${current}" cannot regress to "${next}"`,
    { rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION },
  );
}
