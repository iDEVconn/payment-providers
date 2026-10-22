import type { SellerConnectionStatus, SellerConsentStatus } from '../../contracts/index';

/** Official PayPal webhook event names only. */
export const SELLER_ONBOARDING_WEBHOOK_EVENTS = [
  'MERCHANT.ONBOARDING.COMPLETED',
  'MERCHANT.PARTNER-CONSENT.REVOKED',
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-ONBOARDING-INITIATED',
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-CONSENT-GRANTED',
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED',
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-ALREADY-INTEGRATED',
  'CUSTOMER.MERCHANT-INTEGRATION.PRODUCT-SUBSCRIPTION-UPDATED',
  'CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED',
] as const;

export type SellerOnboardingWebhookEvent = (typeof SELLER_ONBOARDING_WEBHOOK_EVENTS)[number];

export function isSellerOnboardingWebhookEvent(
  eventType: string,
): eventType is SellerOnboardingWebhookEvent {
  return (SELLER_ONBOARDING_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}

export function mapSellerWebhookEventToConsentHint(eventType: string): SellerConsentStatus | null {
  switch (eventType) {
    case 'MERCHANT.PARTNER-CONSENT.REVOKED':
      return 'revoked';
    case 'CUSTOMER.MERCHANT-INTEGRATION.SELLER-CONSENT-GRANTED':
    case 'CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED':
    case 'MERCHANT.ONBOARDING.COMPLETED':
      return 'granted';
    default:
      return null;
  }
}

export function deriveSellerConnectionStatus(input: {
  consentStatus: SellerConsentStatus;
  readinessReady: boolean;
  restricted: boolean;
  providerMerchantId: string | null;
  failed?: boolean;
}): SellerConnectionStatus {
  if (input.failed) {
    return 'failed';
  }
  if (input.consentStatus === 'revoked') {
    return 'revoked';
  }
  if (input.readinessReady) {
    return 'active';
  }
  if (input.restricted || (input.providerMerchantId && !input.readinessReady)) {
    return input.providerMerchantId ? 'restricted' : 'onboarding_pending';
  }
  if (input.providerMerchantId) {
    return 'onboarding_pending';
  }
  return 'referral_created';
}
