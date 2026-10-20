import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { buildPaypalMarketplaceExecutor } from '../paypal-marketplace-executor.factory';
import type { ResolvedPaymentRuntime } from '../../../core/index';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
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
      capabilities: evaluateCapabilities(sandboxPaypalProviderConfig({}), context),
    },
  } as ResolvedPaymentRuntime;
}

describe('buildPaypalMarketplaceExecutor', () => {
  it('builds when marketplace is disabled and partner config is minimal', () => {
    expect(() =>
      buildPaypalMarketplaceExecutor({
        runtime: runtime('fake'),
        partnerConfig: { partnerAttributionId: 'bn' },
        nodeEnv: 'development',
      }),
    ).not.toThrow();
  });

  it('returns executor in production when credentials exist', () => {
    const executor = buildPaypalMarketplaceExecutor({
      runtime: runtime('live-provider'),
      partnerConfig: { partnerAttributionId: 'bn' },
      nodeEnv: 'production',
    });
    expect(executor).toBeDefined();
  });
});
