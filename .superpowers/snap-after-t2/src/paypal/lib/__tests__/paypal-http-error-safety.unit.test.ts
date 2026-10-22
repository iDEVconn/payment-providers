import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderFailure } from '../../../core/index';
import { FetchPaypalOAuthHttpClient } from '../live-paypal-http-clients';
import { LivePaypalWebhookVerificationClient } from '../live-paypal-webhook-verification-client';
import { PaypalWebhookVerificationHttpError } from '../paypal-webhook-verification-http';
import { PaypalWebhookVerifier } from '../paypal-webhook-verifier';
import { resolvePaymentRuntime } from '../../../core/index';

const FAKE_CLIENT_ID = 'fake-client-id-abc';
const FAKE_SECRET = 'fake-client-secret-xyz';
const FAKE_TOKEN = 'fake-oauth-access-token-999';
const FAKE_PATH = '/Users/host/secret/apps/microservices/payment/.env';

function assertNoSensitiveLeak(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(FAKE_CLIENT_ID);
  expect(text).not.toContain(FAKE_SECRET);
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(FAKE_PATH);
  expect(text).not.toMatch(/Authorization:\s*Bearer/i);
}

describe('PayPal HTTP error safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizes OAuth connection refusal', async () => {
    const client = new FetchPaypalOAuthHttpClient();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error(`connect ECONNREFUSED ${FAKE_PATH} ${FAKE_CLIENT_ID}`);
        (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
        throw error;
      }),
    );
    try {
      await client.postForm('https://api-m.sandbox.paypal.com/v1/oauth2/token', new URLSearchParams(), {}, 1000);
      throw new Error('expected failure');
    } catch (error) {
      assertNoSensitiveLeak(error);
      const resolved = resolveProviderFailure(error);
      assertNoSensitiveLeak(resolved);
      expect(resolved.retryable).toBe(true);
      expect(resolved.message).toBe('PayPal OAuth request failed due to a network error');
    }
  });

  it('sanitizes OAuth timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }),
    );
    const client = new FetchPaypalOAuthHttpClient();
    try {
      await client.postForm('https://api-m.sandbox.paypal.com/v1/oauth2/token', new URLSearchParams(), {}, 1000);
    } catch (error) {
      assertNoSensitiveLeak(error);
      expect(resolveProviderFailure(error).message).toBe('PayPal OAuth request timed out');
    }
  });

  it('sanitizes webhook verification network failure', async () => {
    const oauth = { getAccessToken: vi.fn(async () => FAKE_TOKEN) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`getaddrinfo ENOTFOUND internal.${FAKE_CLIENT_ID}.local`);
      }),
    );
    const live = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    try {
      await live.verifyWebhookSignature({
        webhookId: 'WH',
        transmissionId: 'tx',
        transmissionTime: '2026-01-01T00:00:00Z',
        certUrl: 'https://example.test/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
        webhookEvent: {},
      });
    } catch (error) {
      assertNoSensitiveLeak(error);
      expect(error).toBeInstanceOf(PaypalWebhookVerificationHttpError);
      expect((error as Error).message).toBe(
        'PayPal webhook verification failed due to a network error',
      );
    }
  });

  it('maps verification HTTP 503 to retryable unavailable without raw body', async () => {
    const runtime = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    const client = {
      verifyWebhookSignature: async () => {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          `PayPal webhook verification HTTP 503 body=${FAKE_SECRET}`,
        );
      },
    };
    const verifier = new PaypalWebhookVerifier(runtime, client, 'development');
    const result = await verifier.verify({
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      webhookId: 'wh-1',
      rawBody: '{"event_type":"TEST"}',
      headers: {
        transmissionId: 'tx-1',
        transmissionTime: '2026-01-01T00:00:00Z',
        certUrl: 'https://example.test/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
      },
    });
    assertNoSensitiveLeak(result);
    expect(result.failureKind).toBe('verification_unavailable');
    expect(result.unavailableReason).toBe('PayPal webhook verification is temporarily unavailable');
  });

  it('keeps invalid signature distinct from network unavailable', async () => {
    const runtime = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    const verifier = new PaypalWebhookVerifier(
      runtime,
      {
        verifyWebhookSignature: async () => ({ verification_status: 'FAILURE' }),
      },
      'development',
    );
    const result = await verifier.verify({
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      webhookId: 'wh-1',
      rawBody: '{"event_type":"TEST","resource":{"id":"r1"}}',
      headers: {
        transmissionId: 'tx-1',
        transmissionTime: '2026-01-01T00:00:00Z',
        certUrl: 'https://example.test/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
      },
    });
    expect(result.failureKind).toBe('signature_rejected');
    expect(result.unavailableReason).toBe('PayPal rejected webhook signature');
  });

  it('sanitizes unexpected thrown values from OAuth transport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw { message: `Bearer ${FAKE_TOKEN}`, clientSecret: FAKE_SECRET };
      }),
    );
    const client = new FetchPaypalOAuthHttpClient();
    try {
      await client.postForm('https://api-m.sandbox.paypal.com/v1/oauth2/token', new URLSearchParams(), {}, 1000);
    } catch (error) {
      assertNoSensitiveLeak(error);
    }
  });
});
