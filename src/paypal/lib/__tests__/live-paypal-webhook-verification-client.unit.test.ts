import { afterEach, describe, expect, it, vi } from 'vitest';
import { LivePaypalWebhookVerificationClient } from '../live-paypal-webhook-verification-client';
import { PaypalWebhookVerificationHttpError } from '../paypal-webhook-verification-http';

describe('LivePaypalWebhookVerificationClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const oauth = {
    getAccessToken: vi.fn(async () => 'test-token'),
  };

  const baseInput = {
    webhookId: 'WH-1',
    transmissionId: 'tx-1',
    transmissionTime: '2026-01-01T00:00:00Z',
    certUrl: 'https://example.test/cert',
    authAlgo: 'SHA256withRSA',
    transmissionSig: 'sig',
    webhookEvent: { event_type: 'PAYMENT.CAPTURE.COMPLETED' },
  };

  it('uses sandbox verify URL and maps SUCCESS', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ verification_status: 'SUCCESS' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    const result = await client.verifyWebhookSignature(baseInput);
    expect(result.verification_status).toBe('SUCCESS');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature',
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization)).toContain('test-token');
  });

  it('uses live verify URL when environment is live', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ verification_status: 'FAILURE' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'live' },
      'live',
      5_000,
    );
    await client.verifyWebhookSignature(baseInput);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api-m.paypal.com/v1/notifications/verify-webhook-signature',
    );
  });

  it('classifies retryable HTTP status as verification_unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => '{}',
      })),
    );

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    await expect(client.verifyWebhookSignature(baseInput)).rejects.toMatchObject({
      kind: 'verification_unavailable',
    });
  });

  it('classifies non-retryable HTTP status as invalid_payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":"invalid_client"}',
      })),
    );

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    await expect(client.verifyWebhookSignature(baseInput)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('does not include oauth access token in thrown verification errors', async () => {
    oauth.getAccessToken.mockResolvedValueOnce('super-secret-oauth-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    try {
      await client.verifyWebhookSignature(baseInput);
      throw new Error('expected verify to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PaypalWebhookVerificationHttpError);
      expect((error as PaypalWebhookVerificationHttpError).kind).toBe('verification_unavailable');
      expect(String(error)).not.toContain('super-secret-oauth-token');
    }
  });

  it('rejects malformed JSON verify responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => 'not-json',
      })),
    );

    const client = new LivePaypalWebhookVerificationClient(
      oauth as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    await expect(client.verifyWebhookSignature(baseInput)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });
});
