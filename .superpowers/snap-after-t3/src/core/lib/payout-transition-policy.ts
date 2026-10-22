import type { PaymentOperationStatus, PayoutFinancialStatus } from '../../contracts/index';

const PAYOUT_ITEM_TERMINAL: ReadonlySet<PayoutFinancialStatus> = new Set([
  'succeeded',
  'failed',
  'denied',
  'blocked',
  'returned',
  'refunded',
  'cancelled',
]);

export function mapPaypalBatchStatus(status: string): PayoutFinancialStatus {
  switch (status.toUpperCase()) {
    case 'PENDING':
      return 'accepted';
    case 'PROCESSING':
      return 'processing';
    case 'SUCCESS':
      return 'processing';
    case 'DENIED':
      return 'denied';
    default:
      return 'unknown';
  }
}

export function mapPaypalItemTransactionStatus(status: string): PayoutFinancialStatus {
  switch (status.toUpperCase()) {
    case 'SUCCESS':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    case 'UNCLAIMED':
      return 'unclaimed';
    case 'RETURNED':
      return 'returned';
    case 'ONHOLD':
      return 'held';
    case 'BLOCKED':
      return 'blocked';
    case 'REFUNDED':
      return 'refunded';
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function mapPayoutWebhookEventToFinancialStatus(
  eventType: string,
): PayoutFinancialStatus | null {
  switch (eventType) {
    case 'PAYMENT.PAYOUTSBATCH.DENIED':
      return 'denied';
    case 'PAYMENT.PAYOUTSBATCH.PROCESSING':
      return 'processing';
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
      return 'processing';
    case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED':
      return 'succeeded';
    case 'PAYMENT.PAYOUTS-ITEM.FAILED':
      return 'failed';
    case 'PAYMENT.PAYOUTS-ITEM.BLOCKED':
      return 'blocked';
    case 'PAYMENT.PAYOUTS-ITEM.HELD':
      return 'held';
    case 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED':
      return 'unclaimed';
    case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
      return 'returned';
    case 'PAYMENT.PAYOUTS-ITEM.REFUNDED':
      return 'refunded';
    case 'PAYMENT.PAYOUTS-ITEM.CANCELED':
      return 'cancelled';
    default:
      return null;
  }
}

export function mapPayoutWebhookEventToOperationKind(
  eventType: string,
): 'payout_batch' | 'payout_item' | null {
  if (eventType.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    return 'payout_batch';
  }
  if (eventType.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    return 'payout_item';
  }
  return null;
}

export function payoutFinancialStatusToOperationStatus(
  payoutStatus: PayoutFinancialStatus,
): PaymentOperationStatus {
  if (payoutStatus === 'succeeded') {
    return 'succeeded';
  }
  if (
    payoutStatus === 'failed' ||
    payoutStatus === 'denied' ||
    payoutStatus === 'blocked' ||
    payoutStatus === 'returned' ||
    payoutStatus === 'refunded' ||
    payoutStatus === 'cancelled'
  ) {
    return 'failed';
  }
  if (payoutStatus === 'unknown') {
    return 'unknown';
  }
  return 'submitted';
}

export function assertPayoutFinancialTransitionAllowed(
  current: PayoutFinancialStatus,
  next: PayoutFinancialStatus,
): void {
  if (current === next) {
    return;
  }
  if (
    PAYOUT_ITEM_TERMINAL.has(current) &&
    current === 'succeeded' &&
    next !== 'returned' &&
    next !== 'refunded'
  ) {
    throw new Error(`Terminal payout status "${current}" cannot regress to "${next}"`);
  }
  if (PAYOUT_ITEM_TERMINAL.has(current) && current !== 'succeeded' && current !== next) {
    throw new Error(`Terminal payout status "${current}" cannot change to "${next}"`);
  }
}

export function deriveBatchPayoutStatus(
  itemStatuses: PayoutFinancialStatus[],
): PayoutFinancialStatus {
  if (itemStatuses.length === 0) {
    return 'accepted';
  }
  if (itemStatuses.every((status) => status === 'pending' || status === 'accepted')) {
    return 'accepted';
  }
  if (itemStatuses.every((status) => status === 'succeeded')) {
    return 'succeeded';
  }
  if (itemStatuses.every((status) => PAYOUT_ITEM_TERMINAL.has(status))) {
    if (itemStatuses.some((status) => status === 'succeeded')) {
      return 'processing';
    }
    return 'failed';
  }
  if (itemStatuses.some((status) => status === 'unclaimed' || status === 'held')) {
    return 'processing';
  }
  if (itemStatuses.some((status) => status === 'unknown')) {
    return 'unknown';
  }
  return 'processing';
}
