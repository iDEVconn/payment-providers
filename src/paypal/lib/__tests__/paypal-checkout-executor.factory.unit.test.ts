import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPaymentRuntime } from '../../../core/index';
import { buildPaypalCheckoutExecutor } from '../paypal-checkout-executor.factory';

function runtime(overrides: Partial<ResolvedPaymentRuntime> = {}): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
    },
    descriptor: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      capabilities: [],
    },
    checkoutCredentials: {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    },
    ...overrides,
  };
}

describe('buildPaypalCheckoutExecutor', () => {
  it('throws in production when checkout credentials are missing', () => {
    expect(() =>
      buildPaypalCheckoutExecutor({
        runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }),
        strategyFactory: vi.fn(),
        nodeEnv: 'production',
        envPath: 'apps/microservices/payment/.env',
      }),
    ).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it('forbids explicit fake HTTP composition in production', () => {
    expect(() =>
      buildPaypalCheckoutExecutor({
        runtime: runtime(),
        strategyFactory: vi.fn(),
        nodeEnv: 'production',
        envPath: 'apps/microservices/payment/.env',
        forceFakeHttp: true,
      }),
    ).toThrow(/fake PayPal HTTP is forbidden/);
  });

  it('builds a live-provider executor when credentials exist', () => {
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: vi.fn(),
      nodeEnv: 'development',
      envPath: 'apps/microservices/payment/.env',
    });

    expect(executor).toBeDefined();
    expect(typeof executor.getOrder).toBe('function');
    expect(typeof executor.getRefund).toBe('function');
  });
});
