import { describe, expect, it } from 'vitest';

describe('@idevconn/payment-providers exports', () => {
  it('loads the root entry', async () => {
    const root = await import('../src/index');
    expect(root.CheckoutLifecycleService).toBeDefined();
    expect(root.buildOperationIdempotencyScope).toBeDefined();
  });

  it('loads the PayPal subpath', async () => {
    const paypal = await import('../src/paypal/index');
    expect(paypal.PaypalWebhookVerifier).toBeDefined();
    expect(paypal.PaypalPaymentProvider).toBeUndefined();
  });

  it('loads the legacy subpath with the checkout provider and LegacyPaymentError', async () => {
    const legacy = await import('../src/legacy/index');
    expect(legacy.PaypalPaymentProvider).toBeDefined();
    expect(legacy.createPaypalPaymentProvider).toBeDefined();
    expect(legacy.LegacyPaymentError).toBeDefined();
  });

  it('keeps the root free of the legacy runtime value', async () => {
    const root = await import('../src/index');
    expect((root as Record<string, unknown>)['LegacyPaymentError']).toBeUndefined();
  });
});
