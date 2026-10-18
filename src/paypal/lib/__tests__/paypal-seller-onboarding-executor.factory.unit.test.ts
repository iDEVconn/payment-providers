import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../../../core/index';
import { buildPaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor.factory';
import type { ResolvedPaymentRuntime } from '../../../core/index';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'edc',
  environment: 'sandbox' as const,
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
      capabilities: evaluateCapabilities(() => undefined, context),
    },
  } as ResolvedPaymentRuntime;
}

describe('buildPaypalSellerOnboardingExecutor', () => {
  it('does not require partner configuration when seller onboarding is disabled', () => {
    expect(() =>
      buildPaypalSellerOnboardingExecutor({
        runtime: runtime('fake'),
        nodeEnv: 'development',
        envPath: 'apps/microservices/payment/.env',
        get: () => undefined,
      }),
    ).not.toThrow();
  });

  it('fails closed in production when enabled without partner configuration', () => {
    expect(() =>
      buildPaypalSellerOnboardingExecutor({
        runtime: runtime('live-provider'),
        nodeEnv: 'production',
        envPath: 'apps/microservices/payment/.env',
        get: (key) => (key === 'PAYPAL_SELLER_ONBOARDING_ENABLED' ? 'true' : undefined),
      }),
    ).toThrow(/seller onboarding configuration missing/);
  });
});
