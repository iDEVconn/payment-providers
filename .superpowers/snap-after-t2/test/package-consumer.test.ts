import { describe, expect, it } from 'vitest';

describe('@idevconn/payment-providers exports', () => {
  it('loads the root entry', async () => {
    const root = await import('../src/index');
    expect(root.CheckoutLifecycleService).toBeDefined();
    expect(root.buildOperationIdempotencyScope).toBeDefined();
  });

  it('loads the PayPal subpath', async () => {
    const paypal = await import('../src/paypal/index');
    expect(paypal.PaypalPaymentProvider).toBeDefined();
  });
});
