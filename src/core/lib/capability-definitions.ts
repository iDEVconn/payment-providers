import type { PaymentCapability } from '../../contracts/index';

export type CapabilityDefinition = {
  capability: PaymentCapability;
  implemented: boolean;
  enabledEnvKey: string;
  requiredEnvKeys: string[];
  defaultEnabled: boolean;
};

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    capability: 'checkout',
    implemented: true,
    enabledEnvKey: 'PAYPAL_CHECKOUT_ENABLED',
    requiredEnvKeys: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    defaultEnabled: true,
  },
  {
    capability: 'refund',
    implemented: true,
    enabledEnvKey: 'PAYPAL_REFUNDS_ENABLED',
    requiredEnvKeys: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    defaultEnabled: false,
  },
  {
    capability: 'payout',
    implemented: true,
    enabledEnvKey: 'PAYPAL_PAYOUTS_ENABLED',
    requiredEnvKeys: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    defaultEnabled: false,
  },
  {
    capability: 'subscription',
    implemented: true,
    enabledEnvKey: 'PAYPAL_SUBSCRIPTIONS_ENABLED',
    requiredEnvKeys: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    defaultEnabled: true,
  },
  {
    capability: 'seller_onboarding',
    implemented: true,
    enabledEnvKey: 'PAYPAL_SELLER_ONBOARDING_ENABLED',
    requiredEnvKeys: [
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_PARTNER_MERCHANT_ID',
      'PAYPAL_PARTNER_ATTRIBUTION_ID',
      'PAYPAL_SELLER_ONBOARDING_RETURN_URL',
    ],
    defaultEnabled: false,
  },
  {
    capability: 'marketplace_checkout',
    implemented: true,
    enabledEnvKey: 'PAYPAL_MARKETPLACE_ENABLED',
    requiredEnvKeys: [
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_PARTNER_MERCHANT_ID',
      'PAYPAL_PARTNER_ATTRIBUTION_ID',
    ],
    defaultEnabled: false,
  },
  {
    capability: 'authorization',
    implemented: false,
    enabledEnvKey: 'PAYPAL_AUTHORIZATION_ENABLED',
    requiredEnvKeys: [],
    defaultEnabled: false,
  },
  {
    capability: 'seller_disbursement',
    implemented: false,
    enabledEnvKey: 'PAYPAL_DELAYED_DISBURSEMENT_ENABLED',
    requiredEnvKeys: [],
    defaultEnabled: false,
  },
  {
    capability: 'vault',
    implemented: false,
    enabledEnvKey: 'PAYPAL_VAULT_ENABLED',
    requiredEnvKeys: [],
    defaultEnabled: false,
  },
  {
    capability: 'invoicing',
    implemented: false,
    enabledEnvKey: 'PAYPAL_INVOICING_ENABLED',
    requiredEnvKeys: [],
    defaultEnabled: false,
  },
] as const;
