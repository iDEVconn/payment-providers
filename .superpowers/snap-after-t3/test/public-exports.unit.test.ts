import { describe, expect, it } from 'vitest';

describe('public package exports', () => {
  it('resolves the root entrypoint with explicit configuration and recovery types', async () => {
    const root = await import('../src/index');
    expect(root.PaymentRecoveryService).toBeDefined();
    expect(root.WebhookProcessingService).toBeDefined();
    expect(root.PaymentReliabilityError).toBeDefined();
    expect(root.PAYMENT_RELIABILITY_ERROR).toBeDefined();
    expect(root.PaymentProviderConfig).toBeUndefined();
    expect(typeof root.resolvePaymentRuntime).toBe('function');
    expect(root.isRecoverableEvidenceRow).toBeDefined();
    expect(root.classifyWebhookEvidenceResume).toBeDefined();
    expect(root.EnvGetter).toBeUndefined();
    expect(root.readEnvEnabled).toBeUndefined();
    expect(root.readPaymentEnvironment).toBeUndefined();
    expect(root.PAYMENT_MS_ENV_PATH).toBeUndefined();
  });

  it('exports PaymentProviderConfig as a type from the root entrypoint', async () => {
    const root = await import('../src/index');
    const config: import('../src/core/lib/payment-provider-config').PaymentProviderConfig = {
      environment: 'sandbox',
      applicationRef: 'test-app',
    };
    expect(root.resolvePaymentRuntime({ config }).context.environment).toBe('sandbox');
  });

  it('resolves the PayPal subpath entrypoint', async () => {
    const paypal = await import('../src/paypal/index');
    expect(paypal.PaypalWebhookVerifier).toBeDefined();
    expect(paypal.LivePaypalWebhookVerificationClient).toBeDefined();
    expect(paypal.createPaypalPaymentProvider).toBeDefined();
    expect(paypal.parsePaypalEnvironmentFromEnv).toBeUndefined();
  });
});
