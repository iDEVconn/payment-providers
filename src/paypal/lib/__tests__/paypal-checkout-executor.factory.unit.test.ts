import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPaymentRuntime } from '../../../core/index';
import { PaymentConfigurationError } from '../../../core/lib/payment-configuration-error';
import { buildPaypalCheckoutExecutor } from '../paypal-checkout-executor.factory';

function runtime(overrides: Partial<ResolvedPaymentRuntime> = {}): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
    },
    descriptor: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
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
  it('refuses a reject-mode executor in production when checkout credentials are missing', () => {
    expect(() =>
      buildPaypalCheckoutExecutor({
        runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }),
        strategyFactory: vi.fn(),
        nodeEnv: 'production',
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('builds a reject-mode executor outside production when checkout credentials are missing', () => {
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }),
      strategyFactory: vi.fn(),
      nodeEnv: 'development',
    });
    expect(executor).toBeDefined();
  });

  it('forbids explicit fake HTTP composition in production', () => {
    expect(() =>
      buildPaypalCheckoutExecutor({
        runtime: runtime(),
        strategyFactory: vi.fn(),
        nodeEnv: 'production',
        forceFakeHttp: true,
      }),
    ).toThrow(/Fake PayPal HTTP is forbidden in production/);
  });

  it('builds a live-provider executor when credentials exist', () => {
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: vi.fn(),
      nodeEnv: 'development',
    });

    expect(executor).toBeDefined();
    expect(typeof executor.getOrder).toBe('function');
    expect(typeof executor.getRefund).toBe('function');
  });
});
