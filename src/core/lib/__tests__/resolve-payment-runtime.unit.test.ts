import { describe, expect, it } from 'vitest';
import { resolvePaymentRuntime } from '../resolve-payment-runtime';

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

describe('resolvePaymentRuntime', () => {
  it('returns fake mode with a banner when checkout credentials are missing in development', () => {
    const runtime = resolvePaymentRuntime({
      get: env({}),
      nodeEnv: 'development',
    });
    expect(runtime.mode).toBe('fake');
    expect(runtime.configBanner).toContain('PAYPAL_CLIENT_ID');
    expect(runtime.configBanner).toContain('PAYPAL_CLIENT_SECRET');
    const refund = runtime.descriptor.capabilities.find((row) => row.capability === 'refund');
    expect(refund?.ready).toBe(false);
    const payout = runtime.descriptor.capabilities.find((row) => row.capability === 'payout');
    expect(payout?.ready).toBe(false);
    const subscription = runtime.descriptor.capabilities.find(
      (row) => row.capability === 'subscription',
    );
    expect(subscription?.ready).toBe(false);
  });

  it('throws in production when checkout credentials are missing', () => {
    expect(() =>
      resolvePaymentRuntime({
        get: env({}),
        nodeEnv: 'production',
      }),
    ).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it('returns live-provider mode when checkout credentials exist', () => {
    const runtime = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_ENVIRONMENT: 'sandbox',
      }),
      nodeEnv: 'development',
    });
    expect(runtime.mode).toBe('live-provider');
    expect(runtime.checkoutCredentials).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    });
  });

  it('scopes descriptors by accountRef and environment', () => {
    const sandbox = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_ACCOUNT_REF: 'acct-a',
        PAYPAL_ENVIRONMENT: 'sandbox',
      }),
      nodeEnv: 'development',
    });
    const live = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id-live',
        PAYPAL_CLIENT_SECRET: 'secret-live',
        PAYPAL_ACCOUNT_REF: 'acct-b',
        PAYPAL_ENVIRONMENT: 'live',
      }),
      nodeEnv: 'development',
    });

    expect(sandbox.descriptor.accountRef).toBe('acct-a');
    expect(sandbox.descriptor.environment).toBe('sandbox');
    expect(live.descriptor.accountRef).toBe('acct-b');
    expect(live.descriptor.environment).toBe('live');
  });
});
