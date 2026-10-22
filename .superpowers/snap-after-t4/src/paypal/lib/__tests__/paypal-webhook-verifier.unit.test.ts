import { describe, expect, it } from 'vitest';
import type { VerifyWebhookRequest } from '../../../contracts/index';
import { resolvePaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { createBlockedWebhookVerificationClient } from '../blocked-provider-network';
import { FakePaypalWebhookVerificationClient } from '../fake-paypal-webhook-verification-client';
import { PaypalWebhookVerificationHttpError } from '../paypal-webhook-verification-http';
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

function configuredRuntime(nodeEnv: string) {
  return resolvePaymentRuntime({
    config: sandboxPaypalProviderConfig({
      credentials: { clientId: 'id', clientSecret: 'secret' },
    }),
    nodeEnv,
  });
}

describe('PaypalWebhookVerifier', () => {
  it('returns verified=false for invalid signatures without calling PayPal live APIs', async () => {
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('development'),
      new FakePaypalWebhookVerificationClient(),
      'development',
    );
    const result = await verifier.verify(request('invalid'));
    expect(result.verified).toBe(false);
  });

  it('returns verified=true for mocked success signatures', async () => {
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('development'),
      new FakePaypalWebhookVerificationClient(),
      'development',
    );
    const result = await verifier.verify(request('valid'));
    expect(result.verified).toBe(true);
    expect(result.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');
  });

  it('rejects verification in production when webhook id is missing', async () => {
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('production'),
      new FakePaypalWebhookVerificationClient(),
      'production',
    );
    const result = await verifier.verify({
      ...request('valid'),
      webhookId: '',
    });
    expect(result.verified).toBe(false);
    expect(result.failureKind).toBe('verification_unavailable');
    expect(result.unavailableReason).toMatch(/webhook ID is missing/i);
  });

  it('returns verification_unavailable when the client blocks provider access', async () => {
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('development'),
      createBlockedWebhookVerificationClient(),
      'development',
    );
    const result = await verifier.verify(request('forged'));
    expect(result.verified).toBe(false);
    expect(result.failureKind).toBe('verification_unavailable');
    expect(result.unavailableReason).toBe(
      'Webhook verification is unavailable because payment provider access is not configured or is disabled.',
    );
    expect(result.transmissionId).toBe('tx-1');
    expect(result.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');
    expect(result.resourceId).toBe('order-1');
  });

  it('classifies unexpected transport throws as verification_unavailable without leaking', async () => {
    const client = new FakePaypalWebhookVerificationClient();
    client.verifyWebhookSignature = async () => {
      throw new Error('Authorization: Bearer fake-access-token ECONNREFUSED internal-paypal-proxy');
    };
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('development'),
      client,
      'development',
    );
    const result = await verifier.verify(request('valid'));
    expect(result.verified).toBe(false);
    expect(result.failureKind).toBe('verification_unavailable');
    expect(JSON.stringify(result)).not.toContain('fake-access-token');
    expect(result.unavailableReason).toBe(
      'PayPal webhook verification is temporarily unavailable',
    );
  });

  it('classifies provider HTTP outages as verification_unavailable', async () => {
    const client = new FakePaypalWebhookVerificationClient();
    client.verifyWebhookSignature = async () => {
      throw new PaypalWebhookVerificationHttpError(
        'verification_unavailable',
        'PayPal webhook verification HTTP 503',
      );
    };
    const verifier = new PaypalWebhookVerifier(
      configuredRuntime('development'),
      client,
      'development',
    );
    const result = await verifier.verify(request('valid'));
    expect(result.verified).toBe(false);
    expect(result.failureKind).toBe('verification_unavailable');
    expect(result.unavailableReason).toBe(
      'PayPal webhook verification is temporarily unavailable',
    );
  });
});
