import type {
  PaymentOperationStatus,
  PlanStatus,
  ProductStatus,
  SubscriptionStatus,
} from '../../contracts/index';

const SUBSCRIPTION_TERMINAL: ReadonlySet<SubscriptionStatus> = new Set(['cancelled', 'expired']);

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
  if (SUBSCRIPTION_TERMINAL.has(current) && next === 'active') {
    throw new Error(`Terminal subscription status "${current}" cannot reactivate to "${next}"`);
  }
}
