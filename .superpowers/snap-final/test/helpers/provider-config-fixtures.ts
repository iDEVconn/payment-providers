import type { PaymentProviderConfig } from '../../src/core/lib/payment-provider-config';

const DEFAULT_SANDBOX_PAYPAL: PaymentProviderConfig = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox',
  capabilityFlags: {
    checkout: true,
    refund: false,
    payout: false,
    subscription: true,
    seller_onboarding: false,
    marketplace_checkout: false,
  },
};

function mergeProviderConfig(
  base: PaymentProviderConfig,
  overrides: Partial<PaymentProviderConfig>,
): PaymentProviderConfig {
  return {
    ...base,
    ...overrides,
    credentials: overrides.credentials
      ? { ...base.credentials, ...overrides.credentials }
      : base.credentials,
    capabilityFlags: overrides.capabilityFlags
      ? { ...base.capabilityFlags, ...overrides.capabilityFlags }
      : base.capabilityFlags,
    partner: overrides.partner ? { ...base.partner, ...overrides.partner } : base.partner,
  };
}

/** Explicit sandbox PayPal configuration for unit tests (never reads process.env). */
export function sandboxPaypalProviderConfig(
  overrides: Partial<PaymentProviderConfig> = {},
): PaymentProviderConfig {
  const environment = overrides.environment ?? DEFAULT_SANDBOX_PAYPAL.environment;
  return mergeProviderConfig({ ...DEFAULT_SANDBOX_PAYPAL, environment }, overrides);
}
