import { describe, expect, it } from 'vitest';
import type { VerifyWebhookRequest } from '../../../contracts/index';
import { resolvePaymentRuntime } from '../../../core/index';
import { FakePaypalWebhookVerificationClient } from '../fake-paypal-webhook-verification-client';
import { PaypalWebhookVerifier } from '../paypal-webhook-verifier';

function request(sig: string): VerifyWebhookRequest {
  return {
    providerCode: 'paypal',
    accountRef: 'default',
    environment: 'sandbox',
    webhookId: 'wh-1',
    rawBody: JSON.stringify({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'order-1' },
    }),
    headers: {
      transmissionId: 'tx-1',
      transmissionTime: '2026-01-01T00:00:00Z',
      certUrl: 'https://example.test/cert',
      authAlgo: 'SHA256withRSA',
      transmissionSig: sig,
    },
  };
}

describe('PaypalWebhookVerifier', () => {
  it('returns verified=false for invalid signatures without calling PayPal live APIs', async () => {
    const runtime = resolvePaymentRuntime({
      get: (key) =>
        ({
          PAYPAL_CLIENT_ID: 'id',
          PAYPAL_CLIENT_SECRET: 'secret',
        })[key],
      nodeEnv: 'development',
    });
    const verifier = new PaypalWebhookVerifier(
      runtime,
      new FakePaypalWebhookVerificationClient(),
      'development',
      'apps/microservices/payment/.env',
    );
    const result = await verifier.verify(request('invalid'));
    expect(result.verified).toBe(false);
  });

  it('returns verified=true for mocked success signatures', async () => {
    const runtime = resolvePaymentRuntime({
      get: (key) =>
        ({
          PAYPAL_CLIENT_ID: 'id',
          PAYPAL_CLIENT_SECRET: 'secret',
        })[key],
      nodeEnv: 'development',
    });
    const verifier = new PaypalWebhookVerifier(
      runtime,
      new FakePaypalWebhookVerificationClient(),
      'development',
      'apps/microservices/payment/.env',
    );
    const result = await verifier.verify(request('valid'));
    expect(result.verified).toBe(true);
    expect(result.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');
  });
});
