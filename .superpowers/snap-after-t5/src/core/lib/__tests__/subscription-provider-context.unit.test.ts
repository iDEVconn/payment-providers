import { describe, expect, it } from 'vitest';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { resolvePaymentSubscriptionProviderContext } from '../subscription-provider-context';

describe('resolvePaymentSubscriptionProviderContext', () => {
  const env = {
    PAYMENT_PROVIDER: 'paypal-trusted',
    PAYPAL_ACCOUNT_REF: 'trusted-acct',
    PAYPAL_ENVIRONMENT: 'live',
  };
  const read = (key: string) => env[key as keyof typeof env];

  it('requires environment from the composition root when not overridden', () => {
    expect(() =>
      resolvePaymentSubscriptionProviderContext(() => undefined, {
        applicationRef: 'trusted-app',
      }),
    ).toThrow(/composition root/);
  });

  it('requires applicationRef from the composition root', () => {
    expect(() =>
      resolvePaymentSubscriptionProviderContext(read, {
        applicationRef: '',
        environment: 'live',
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('uses explicit environment override with configuration defaults', () => {
    expect(
      resolvePaymentSubscriptionProviderContext(read, {
        environment: 'live',
        applicationRef: 'trusted-app',
      }),
    ).toEqual({
      providerCode: 'paypal-trusted',
      accountRef: 'trusted-acct',
      applicationRef: 'trusted-app',
      environment: 'live',
    });
  });

  it('allows explicit sandbox override when configuration is live', () => {
    expect(
      resolvePaymentSubscriptionProviderContext(read, {
        environment: 'sandbox',
        applicationRef: 'trusted-app',
      }),
    ).toEqual({
      providerCode: 'paypal-trusted',
      accountRef: 'trusted-acct',
      applicationRef: 'trusted-app',
      environment: 'sandbox',
    });
  });

  it('produces identical scope on repeated resolution', () => {
    const first = resolvePaymentSubscriptionProviderContext(read, {
      environment: 'sandbox',
      applicationRef: 'trusted-app',
    });
    const second = resolvePaymentSubscriptionProviderContext(read, {
      environment: 'sandbox',
      applicationRef: 'trusted-app',
    });
    expect(first).toEqual(second);
  });

  it('separates sandbox and live operation scopes derived from context', () => {
    const sandboxContext = resolvePaymentSubscriptionProviderContext(read, {
      environment: 'sandbox',
      applicationRef: 'trusted-app',
    });
    const liveContext = resolvePaymentSubscriptionProviderContext(read, {
      environment: 'live',
      applicationRef: 'trusted-app',
    });
    const sandboxScope = buildOperationIdempotencyScope({
      applicationRef: sandboxContext.applicationRef,
      accountRef: sandboxContext.accountRef,
      environment: sandboxContext.environment,
      kind: 'catalog_product',
    });
    const liveScope = buildOperationIdempotencyScope({
      applicationRef: liveContext.applicationRef,
      accountRef: liveContext.accountRef,
      environment: liveContext.environment,
      kind: 'catalog_product',
    });
    expect(sandboxScope).toBe('trusted-app::trusted-acct::sandbox::catalog_product');
    expect(liveScope).toBe('trusted-app::trusted-acct::live::catalog_product');
    expect(sandboxScope).not.toBe(liveScope);
  });

  it('changes operation scope when applicationRef or accountRef changes', () => {
    const baseline = buildOperationIdempotencyScope({
      ...resolvePaymentSubscriptionProviderContext(read, {
        environment: 'sandbox',
        applicationRef: 'trusted-app',
      }),
      kind: 'catalog_product',
    });
    const otherAccount = buildOperationIdempotencyScope({
      ...resolvePaymentSubscriptionProviderContext(read, {
        environment: 'sandbox',
        applicationRef: 'trusted-app',
        accountRef: 'other-acct',
      }),
      kind: 'catalog_product',
    });
    const otherApp = buildOperationIdempotencyScope({
      ...resolvePaymentSubscriptionProviderContext(read, {
        environment: 'sandbox',
        applicationRef: 'other-app',
      }),
      kind: 'catalog_product',
    });
    expect(otherAccount).not.toBe(baseline);
    expect(otherApp).not.toBe(baseline);
  });

  it('applies override precedence over configuration', () => {
    expect(
      resolvePaymentSubscriptionProviderContext(read, {
        providerCode: ' override-provider ',
        accountRef: ' override-acct ',
        applicationRef: ' override-app ',
        environment: 'sandbox',
      }),
    ).toEqual({
      providerCode: 'override-provider',
      accountRef: 'override-acct',
      applicationRef: 'override-app',
      environment: 'sandbox',
    });
  });
});
