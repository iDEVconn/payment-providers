import type { PaymentExecutionMode } from './execution-mode';

export type PaymentCapability =
  | 'checkout'
  | 'refund'
  | 'payout'
  | 'subscription'
  | 'seller_onboarding'
  | 'marketplace_checkout'
  | 'authorization'
  | 'seller_disbursement'
  | 'vault'
  | 'invoicing';

export const PAYMENT_CAPABILITIES: readonly PaymentCapability[] = [
  'checkout',
  'refund',
  'payout',
  'subscription',
  'seller_onboarding',
  'marketplace_checkout',
  'authorization',
  'seller_disbursement',
  'vault',
  'invoicing',
] as const;

export type PaymentEnvironment = 'sandbox' | 'live';

export type PaymentAccountContext = {
  providerCode: string;
  accountRef: string;
  environment: PaymentEnvironment;
  applicationRef: string;
};

export type CapabilityAvailability = {
  capability: PaymentCapability;
  implemented: boolean;
  enabled: boolean;
  configured: boolean;
  eligible: boolean | 'unknown';
  ready: boolean;
  unavailableReason?: string;
};

export type PaymentProviderDescriptor = PaymentAccountContext & {
  capabilities: CapabilityAvailability[];
  executionMode?: PaymentExecutionMode | null;
  simulatedExecutionAvailable?: boolean;
  providerCallsEnabled?: boolean;
};
