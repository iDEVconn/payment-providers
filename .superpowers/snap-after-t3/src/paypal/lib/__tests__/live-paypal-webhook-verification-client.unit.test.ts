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

  it('classifies non-retryable HTTP status as verification_unavailable, never a rejection', async () => {
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
      kind: 'verification_unavailable',
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

  it('treats malformed JSON verify responses as verification_unavailable', async () => {
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
      kind: 'verification_unavailable',
    });
  });
});

describe('LivePaypalWebhookVerificationClient raw event and token handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const scope = { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' as const };
  const headers = {
    webhookId: 'WH-1',
    transmissionId: 'tx-1',
    transmissionTime: '2026-01-01T00:00:00Z',
    certUrl: 'https://example.test/cert',
    authAlgo: 'SHA256withRSA',
    transmissionSig: 'sig',
  };

  function response(status: number, text: string) {
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }

  it('sends the original raw event text byte-for-byte as webhook_event', async () => {
    const raw =
      '{ "id":"WH-9", "event_type":"PAYMENT.SALE.COMPLETED", "summary":"caf\\u00e9 \\u2713 \\ud83d\\ude00",' +
      ' "resource":{"amount":{"total":"1.10","value":1.10,"big":1e2,"neg":-0.0},"id":"S-1"},' +
      ' "zeta":1, "alpha":2 }';
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      response(200, '{"verification_status":"SUCCESS"}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken: vi.fn(async () => 'token') } as never,
      scope,
      'sandbox',
      5_000,
    );

    await client.verifyWebhookSignature({
      ...headers,
      webhookEvent: JSON.parse(raw),
      rawWebhookEvent: raw,
    });

    const sent = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(sent.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(sent).toContain('"total":"1.10","value":1.10,"big":1e2,"neg":-0.0');
    expect(sent).toContain('caf\\u00e9 \\u2713 \\ud83d\\ude00');
    expect(sent.indexOf('"zeta"')).toBeLessThan(sent.indexOf('"alpha"'));
    expect(sent).not.toContain(JSON.stringify(JSON.parse(raw)));
    const outer = JSON.parse(sent) as Record<string, unknown>;
    expect(outer).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://example.test/cert',
      transmission_id: 'tx-1',
      transmission_sig: 'sig',
      transmission_time: '2026-01-01T00:00:00Z',
      webhook_id: 'WH-1',
    });
    expect(outer['webhook_event']).toEqual(JSON.parse(raw));
  });

  it('refuses a raw event that is not a JSON object without calling PayPal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken: vi.fn(async () => 'token') } as never,
      scope,
      'sandbox',
      5_000,
    );
    for (const raw of ['[1,2]', 'null', '"x"', '{"a":1} {"b":2}', '{"a":1}}, "webhook_id":"x"']) {
      await expect(
        client.verifyWebhookSignature({ ...headers, webhookEvent: {}, rawWebhookEvent: raw }),
      ).rejects.toMatchObject({ kind: 'invalid_payload' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects with the bearer token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      response(200, '{"verification_status":"SUCCESS"}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken: vi.fn(async () => 'token') } as never,
      scope,
      'sandbox',
      5_000,
    );
    await client.verifyWebhookSignature({ ...headers, webhookEvent: {} });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('evicts the token and retries once after a 401', async () => {
    const getAccessToken = vi.fn(async (_scope: unknown, options?: { rejectedToken?: string }) =>
      options?.rejectedToken ? 'fresh' : 'revoked',
    );
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>)['Authorization'] === 'Bearer revoked'
        ? response(401, '{"name":"AUTHENTICATION_FAILURE"}')
        : response(200, '{"verification_status":"SUCCESS"}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken } as never,
      scope,
      'sandbox',
      5_000,
    );
    const result = await client.verifyWebhookSignature({ ...headers, webhookEvent: {} });
    expect(result.verification_status).toBe('SUCCESS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken.mock.calls[1]?.[1]).toEqual({ rejectedToken: 'revoked' });
  });

  for (const status of [400, 401, 403, 404, 409, 422]) {
    it(`maps HTTP ${status} after the token retry to verification_unavailable`, async () => {
      const fetchMock = vi.fn(async () => response(status, '{"name":"X"}'));
      vi.stubGlobal('fetch', fetchMock);
      const client = new LivePaypalWebhookVerificationClient(
        { getAccessToken: vi.fn(async () => 'secret-access-token') } as never,
        scope,
        'sandbox',
        5_000,
      );
      const error = await client
        .verifyWebhookSignature({ ...headers, webhookEvent: {} })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PaypalWebhookVerificationHttpError);
      expect((error as PaypalWebhookVerificationHttpError).kind).toBe('verification_unavailable');
      expect(String(error)).not.toContain('secret-access-token');
      expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    });
  }

  it('maps a 2xx without verification_status to verification_unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, '{}')),
    );
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken: vi.fn(async () => 'token') } as never,
      scope,
      'sandbox',
      5_000,
    );
    await expect(
      client.verifyWebhookSignature({ ...headers, webhookEvent: {} }),
    ).rejects.toMatchObject({ kind: 'verification_unavailable' });
  });
});

describe('LivePaypalWebhookVerificationClient outer body shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds valid JSON when every outer field is undefined (untyped callers)', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({ ok: true, status: 200, text: async () => '{"verification_status":"SUCCESS"}' }) as never,
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new LivePaypalWebhookVerificationClient(
      { getAccessToken: vi.fn(async () => 'token') } as never,
      { providerCode: 'paypal', accountRef: 'default', environment: 'sandbox' },
      'sandbox',
      5_000,
    );
    await client.verifyWebhookSignature({
      webhookEvent: {},
      rawWebhookEvent: '{"id":"WH-1"}',
    } as never);
    const sent = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(sent).toBe('{"webhook_event":{"id":"WH-1"}}');
    expect(JSON.parse(sent)).toEqual({ webhook_event: { id: 'WH-1' } });
  });
});
