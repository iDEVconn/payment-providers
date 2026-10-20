import type {
  PaymentOperationStatus,
  PlanStatus,
  ProductStatus,
  SubscriptionStatus,
} from '../../contracts/index';

const SUBSCRIPTION_TERMINAL: ReadonlySet<SubscriptionStatus> = new Set(['cancelled', 'expired']);

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
    const candidate = parsed.resource?.update_time ?? parsed.resource?.create_time;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return null;
    }
    const epochMs = Date.parse(candidate);
    if (Number.isNaN(epochMs)) {
      return null;
    }
    return new Date(epochMs).toISOString();
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

function compareProviderStateTimestamps(
  stored: string | null,
  incoming: string,
): 'older' | 'newer' | 'equal' {
  if (!stored) {
    return 'newer';
  }
  const storedMs = Date.parse(stored);
  const incomingMs = Date.parse(incoming);
  if (incomingMs > storedMs) {
    return 'newer';
  }
  if (incomingMs < storedMs) {
    return 'older';
  }
  return 'equal';
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

  const storedWatermark = readSubscriptionProviderStateWatermark(input.operation);
  const incomingTimestamp = input.providerStateTimestamp;
  if (!incomingTimestamp) {
    if (storedWatermark) {
      return { action: 'noop', reason: 'missing_timestamp' };
    }
    return { action: 'apply', providerStateWatermark: null };
  }

  const ordering = compareProviderStateTimestamps(storedWatermark, incomingTimestamp);
  if (ordering === 'older') {
    return { action: 'noop', reason: 'stale' };
  }
  if (ordering === 'equal') {
    const current = input.operation.subscriptionStatus ?? 'approval_pending';
    if (current !== input.desiredStatus) {
      return { action: 'noop', reason: 'equal_conflict' };
    }
    return { action: 'apply', providerStateWatermark: incomingTimestamp };
  }

  return { action: 'apply', providerStateWatermark: incomingTimestamp };
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

export function mapPaypalSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status.toUpperCase()) {
    case 'APPROVAL_PENDING':
      return 'approval_pending';
    case 'APPROVED':
      return 'approved';
    case 'ACTIVE':
      return 'active';
    case 'SUSPENDED':
      return 'suspended';
    case 'CANCELLED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'unknown';
  }
}

export function isSubscriptionWebhookProviderRefreshEvent(eventType: string): boolean {
  return eventType === 'BILLING.SUBSCRIPTION.UPDATED';
}

export function mapSubscriptionWebhookEventToStatus(eventType: string): SubscriptionStatus | null {
  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CREATED':
      return 'approval_pending';
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
      return 'active';
    case 'BILLING.SUBSCRIPTION.APPROVED':
      return 'approved';
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return 'suspended';
    case 'BILLING.SUBSCRIPTION.CANCELLED':
      return 'cancelled';
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'expired';
    default:
      return null;
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

export function isSubscriptionPaymentEvidenceEvent(eventType: string): boolean {
  return (
    eventType === 'PAYMENT.SALE.COMPLETED' ||
    eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' ||
    eventType === 'PAYMENT.SALE.REFUNDED' ||
    eventType === 'PAYMENT.SALE.REVERSED'
  );
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
  if (current === next) {
    return;
  }
  if (SUBSCRIPTION_TERMINAL.has(current)) {
    throw new Error(`Terminal subscription status "${current}" cannot transition to "${next}"`);
  }
  if (current === 'active' && next === 'approval_pending') {
    throw new Error(`Subscription status "${current}" cannot regress to "${next}"`);
  }
}

/** Rejected stale transitions keep the current subscription status. */
export function resolveSubscriptionStatusTransition(
  current: SubscriptionStatus,
  next: SubscriptionStatus,
): SubscriptionStatus {
  if (current === next) {
    return current;
  }
  try {
    assertSubscriptionTransitionAllowed(current, next);
    return next;
  } catch {
    return current;
  }
}
