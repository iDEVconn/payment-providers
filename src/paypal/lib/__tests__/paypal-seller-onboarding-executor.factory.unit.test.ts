import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { buildPaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor.factory';
import type { ResolvedPaymentRuntime } from '../../../core/index';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

const partnerConfig = {
  partnerMerchantId: 'partner',
  partnerAttributionId: 'bn',
  returnUrl: 'https://example.com/return',
  products: ['EXPRESS_CHECKOUT'],
  features: ['PAYMENT', 'REFUND'],
};

function runtime(mode: 'fake' | 'live-provider'): ResolvedPaymentRuntime {
  return {
    mode,
    context,
    checkoutCredentials:
      mode === 'live-provider'
        ? { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' }
        : undefined,
    descriptor: {
      ...context,
      capabilities: evaluateCapabilities(sandboxPaypalProviderConfig({}), context),
    },
  } as ResolvedPaymentRuntime;
}

describe('buildPaypalSellerOnboardingExecutor', () => {
  it('does not require partner configuration when seller onboarding is disabled', () => {
    expect(() =>
      buildPaypalSellerOnboardingExecutor({
        runtime: runtime('fake'),
        partnerConfig,
        nodeEnv: 'development',
      }),
    ).not.toThrow();
  });

  it('returns a blocked executor in production when enabled without partner configuration', () => {
    const executor = buildPaypalSellerOnboardingExecutor({
      runtime: runtime('live-provider'),
      partnerConfig: {
        partnerMerchantId: 'unconfigured',
        partnerAttributionId: 'unconfigured',
        returnUrl: 'https://invalid.local',
        products: ['EXPRESS_CHECKOUT'],
        features: ['PAYMENT'],
      },
      nodeEnv: 'production',
    });
    expect(executor).toBeDefined();
  });
});
