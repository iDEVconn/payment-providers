import { describe, expect, it } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { resolvePaymentSubscriptionProviderContext } from '../subscription-provider-context';

describe('resolvePaymentSubscriptionProviderContext', () => {
  const env = {
    PAYMENT_PROVIDER: 'paypal-trusted',
    PAYPAL_ACCOUNT_REF: 'trusted-acct',
    PAYMENT_APPLICATION_REF: 'trusted-app',
    PAYPAL_ENVIRONMENT: 'live',
  };
  const read = (key: string) => env[key as keyof typeof env];

  it('defaults provider, account, application and treats non-live env as sandbox', () => {
    expect(resolvePaymentSubscriptionProviderContext(() => undefined)).toEqual({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
    });
  });

  it('reads live environment from configuration when not overridden', () => {
    expect(resolvePaymentSubscriptionProviderContext(read)).toEqual({
      providerCode: 'paypal-trusted',
      accountRef: 'trusted-acct',
      applicationRef: 'trusted-app',
      environment: 'live',
    });
  });

  it('allows explicit sandbox override when configuration is live', () => {
    expect(resolvePaymentSubscriptionProviderContext(read, { environment: 'sandbox' })).toEqual({
      providerCode: 'paypal-trusted',
      accountRef: 'trusted-acct',
      applicationRef: 'trusted-app',
      environment: 'sandbox',
    });
  });

  it('produces identical scope on repeated resolution', () => {
    const first = resolvePaymentSubscriptionProviderContext(read, { environment: 'sandbox' });
    const second = resolvePaymentSubscriptionProviderContext(read, { environment: 'sandbox' });
    expect(first).toEqual(second);
  });

  it('separates sandbox and live operation scopes derived from context', () => {
    const sandboxContext = resolvePaymentSubscriptionProviderContext(read, {
      environment: 'sandbox',
    });
    const liveContext = resolvePaymentSubscriptionProviderContext(read);
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
      ...resolvePaymentSubscriptionProviderContext(read, { environment: 'sandbox' }),
      kind: 'catalog_product',
    });
    const otherAccount = buildOperationIdempotencyScope({
      ...resolvePaymentSubscriptionProviderContext(read, {
        environment: 'sandbox',
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
