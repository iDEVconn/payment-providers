import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePaymentRuntime } from '../src/core/lib/resolve-payment-runtime';
import { createPaypalPaymentProvider } from '../src/paypal/lib/paypal-payment-provider';
import { buildPaypalCheckoutExecutor } from '../src/paypal/lib/paypal-checkout-executor.factory';

describe('environment independence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not read process.env when importing package entrypoints', async () => {
    const envSpy = vi.spyOn(process, 'env', 'get').mockImplementation(() => {
      throw new Error('process.env access is forbidden during import');
    });
    await expect(import('../src/index')).resolves.toBeDefined();
    await expect(import('../src/paypal/index')).resolves.toBeDefined();
    envSpy.mockRestore();
  });

  it('resolvePaymentRuntime uses only explicit configuration', () => {
    process.env.PAYPAL_CLIENT_ID = 'host-env-leak-id';
    process.env.PAYPAL_CLIENT_SECRET = 'host-env-leak-secret';
    const runtime = resolvePaymentRuntime({
      config: { environment: 'sandbox', applicationRef: 'test-app' },
      nodeEnv: 'development',
    });
    expect(runtime.mode).toBe('fake');
    expect(runtime.configBanner).not.toContain('host-env-leak');
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
  });

  it('selects sandbox vs live endpoints from explicit environment', () => {
    const sandbox = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    const live = resolvePaymentRuntime({
      config: {
        environment: 'live',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    expect(sandbox.checkoutCredentials?.environment).toBe('sandbox');
    expect(live.checkoutCredentials?.environment).toBe('live');
  });

  it('createPaypalPaymentProvider fails closed without leaking host env secrets in banner', () => {
    const provider = createPaypalPaymentProvider({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'explicit-id', clientSecret: 'explicit-secret' },
      },
    });
    const json = JSON.stringify(provider.describe());
    expect(json).not.toContain('explicit-secret');
  });

  it('missing explicit credentials produce deterministic configuration messaging', () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'sandbox', applicationRef: 'test-app' },
    });
    expect(runtime.configBanner).toContain('credentials.clientId');
    expect(runtime.configBanner).not.toMatch(/apps\/microservices/);
  });

  it('factory builds without envPath or filesystem discovery', () => {
    const runtime = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    const executor = buildPaypalCheckoutExecutor({
      runtime,
      strategyFactory: () => ({ createOrder: vi.fn(), captureOrder: vi.fn() }) as never,
    });
    expect(executor).toBeDefined();
  });
});
