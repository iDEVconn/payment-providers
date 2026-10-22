import type { MarketplaceOrderStatus, MarketplaceUnitStatus } from '../../contracts/index';

export const MARKETPLACE_WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
] as const;

export function isMarketplaceWebhookEvent(eventType: string): boolean {
  return (MARKETPLACE_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}

export function mapMarketplaceCaptureWebhookToUnitStatus(
  eventType: string,
): MarketplaceUnitStatus | null {
  switch (eventType) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'captured';
    case 'PAYMENT.CAPTURE.DENIED':
      return 'declined';
    case 'PAYMENT.CAPTURE.PENDING':
      return 'unknown';
    default:
      return null;
  }
}

export function mapPaypalOrderStatusToMarketplace(status: string): MarketplaceOrderStatus {
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'PARTIALLY_COMPLETED':
      return 'partially_captured';
    case 'APPROVED':
      return 'approved';
    case 'CREATED':
    case 'SAVED':
      return 'created';
    case 'VOIDED':
      return 'failed';
    default:
      return 'unknown';
  }
}

export function deriveMarketplaceOrderStatusFromUnits(
  units: MarketplaceUnitStatus[],
): MarketplaceOrderStatus {
  if (units.length === 0) {
    return 'unknown';
  }
  if (units.every((status) => status === 'captured')) {
    return 'captured';
  }
  if (
    units.some((status) => status === 'captured') &&
    units.some((status) => status !== 'captured')
  ) {
    return 'partially_captured';
  }
  if (units.every((status) => status === 'declined' || status === 'failed')) {
    return 'failed';
  }
  if (units.some((status) => status === 'unknown')) {
    return 'unknown';
  }
  if (units.every((status) => status === 'pending')) {
    return 'created';
  }
  return 'unknown';
}
