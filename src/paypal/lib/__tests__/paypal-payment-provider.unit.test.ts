import { describe, expect, it } from 'vitest';
import { PaymentError } from '@idevconn/payment';
import { PaymentCapabilityError, UNCONFIGURED_FAKE_SIMULATION } from '../../../contracts/index';
import { evaluateCapabilities, resolvePaymentRuntime } from '../../../core/index';
import { PaypalPaymentProvider } from '../paypal-payment-provider';

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

describe('PaypalPaymentProvider', () => {
  it('rejects checkout createOrder with unconfigured-fake provenance in development', async () => {
    const runtime = resolvePaymentRuntime({ get: env({}), nodeEnv: 'development' });
    const provider = new PaypalPaymentProvider(runtime);
    const strategy = provider.createCheckoutStrategy();

    await expect(strategy.createOrder({ amount: '9.99', currency: 'USD' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { simulation: UNCONFIGURED_FAKE_SIMULATION },
    });
  });

  it('throws CAPABILITY_UNAVAILABLE for payout without invoking PayPal checkout', () => {
    const runtime = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      nodeEnv: 'development',
    });
    const provider = new PaypalPaymentProvider(runtime);

    expect(() => provider.requireCapability('payout')).toThrow(PaymentCapabilityError);
  });

  it('keeps separate scoped checkout strategies per accountRef', () => {
    const sandboxA = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_ACCOUNT_REF: 'acct-a',
        PAYPAL_ENVIRONMENT: 'sandbox',
      }),
      nodeEnv: 'development',
    });
    const sandboxB = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_ACCOUNT_REF: 'acct-b',
        PAYPAL_ENVIRONMENT: 'sandbox',
      }),
      nodeEnv: 'development',
    });

    const providerA = new PaypalPaymentProvider(sandboxA);
    const providerB = new PaypalPaymentProvider(sandboxB);
    providerA.createCheckoutStrategy();
    providerB.createCheckoutStrategy();

    expect(providerA.hasScopedCheckoutStrategy('acct-a', 'sandbox')).toBe(true);
    expect(providerA.hasScopedCheckoutStrategy('acct-b', 'sandbox')).toBe(false);
    expect(providerB.hasScopedCheckoutStrategy('acct-b', 'sandbox')).toBe(true);
  });

  it('describe returns secret-free capability readiness', () => {
    const runtime = resolvePaymentRuntime({
      get: env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      nodeEnv: 'development',
    });
    const descriptor = new PaypalPaymentProvider(runtime).describe();
    expect(JSON.stringify(descriptor)).not.toContain('secret');
    expect(descriptor.capabilities).toEqual(
      evaluateCapabilities(
        env({
          PAYPAL_CLIENT_ID: 'id',
          PAYPAL_CLIENT_SECRET: 'secret',
        }),
        runtime.context,
      ),
    );
  });

  it('does not simulate successful financial outcomes from fake checkout', async () => {
    const runtime = resolvePaymentRuntime({ get: env({}), nodeEnv: 'development' });
    const provider = new PaypalPaymentProvider(runtime);

    await expect(
      provider.createCheckoutStrategy().createOrder({ amount: '1.00', currency: 'USD' }),
    ).rejects.toBeInstanceOf(PaymentError);
  });
});
