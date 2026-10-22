import { describe, expect, it } from 'vitest';
import { PAYMENT_CAUSE_CODE, PaymentCapabilityError } from '../../../contracts/index';
import { evaluateCapabilities, resolvePaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { PaypalPaymentProvider } from '../paypal-payment-provider';

describe('PaypalPaymentProvider', () => {
  it('rejects checkout createOrder with unconfigured-fake provenance in development', async () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'sandbox', applicationRef: 'test-app' },
      nodeEnv: 'development',
    });
    const provider = new PaypalPaymentProvider(runtime);
    const strategy = provider.createCheckoutStrategy();

    await expect(strategy.createOrder({ amount: '9.99', currency: 'USD' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      causeCode: PAYMENT_CAUSE_CODE.CHECKOUT_CREDENTIALS_MISSING,
    });
  });

  it('throws CAPABILITY_UNAVAILABLE for payout without invoking PayPal checkout', () => {
    const runtime = resolvePaymentRuntime({
      config: sandboxPaypalProviderConfig({
        credentials: { clientId: 'id', clientSecret: 'secret' },
      }),
      nodeEnv: 'development',
    });
    const provider = new PaypalPaymentProvider(runtime);

    expect(() => provider.requireCapability('payout')).toThrow(PaymentCapabilityError);
  });

  it('keeps separate scoped checkout strategies per accountRef', () => {
    const sandboxA = resolvePaymentRuntime({
      config: sandboxPaypalProviderConfig({
        credentials: { clientId: 'id', clientSecret: 'secret' },
        accountRef: 'acct-a',
      }),
      nodeEnv: 'development',
    });
    const sandboxB = resolvePaymentRuntime({
      config: sandboxPaypalProviderConfig({
        credentials: { clientId: 'id', clientSecret: 'secret' },
        accountRef: 'acct-b',
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
      config: sandboxPaypalProviderConfig({
        credentials: { clientId: 'id', clientSecret: 'secret' },
      }),
      nodeEnv: 'development',
    });
    const descriptor = new PaypalPaymentProvider(runtime).describe();
    expect(JSON.stringify(descriptor)).not.toContain('secret');
    expect(descriptor.capabilities).toEqual(
      evaluateCapabilities(
        sandboxPaypalProviderConfig({
          credentials: { clientId: 'id', clientSecret: 'secret' },
        }),
        runtime.context,
      ),
    );
  });

  it('does not simulate successful financial outcomes from fake checkout', async () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'sandbox', applicationRef: 'test-app' },
      nodeEnv: 'development',
    });
    const provider = new PaypalPaymentProvider(runtime);
    const strategy = provider.createCheckoutStrategy();
    await expect(strategy.createOrder({ amount: '9.99', currency: 'USD' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });
});
