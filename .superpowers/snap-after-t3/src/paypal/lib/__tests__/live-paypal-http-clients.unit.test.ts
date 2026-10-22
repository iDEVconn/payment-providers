import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalOrdersHttpClient,
  FetchPaypalPayoutHttpClient,
  FetchPaypalSellerOnboardingHttpClient,
  FetchPaypalSubscriptionHttpClient,
} from '../live-paypal-http-clients';

const TOKEN = 'live-access-token-123';
const SUBSCRIPTIONS = 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions';
const OAUTH = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';

type FetchInit = RequestInit & { headers: Record<string, string> };

function stubFetch(respond: (url: string, init: FetchInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (url: string, init: FetchInit) => respond(url, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fetch that never answers until its signal aborts (real AbortController timeout). */
function hangingFetch() {
  return stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  );
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('FetchPaypalSubscriptionHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends bearer auth, request id and JSON body and parses a success response', async () => {
    const fetchMock = stubFetch(() =>
      json(201, { id: 'I-1', status: 'APPROVAL_PENDING' }, { 'paypal-debug-id': 'dbg-1' }),
    );
    const response = await new FetchPaypalSubscriptionHttpClient(5_000).request({
      method: 'POST',
      path: SUBSCRIPTIONS,
      accessToken: TOKEN,
      requestId: 'req-1',
      body: { plan_id: 'P-1' },
    });

    expect(response).toEqual({
      status: 201,
      body: { id: 'I-1', status: 'APPROVAL_PENDING' },
      debugId: 'dbg-1',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(SUBSCRIPTIONS);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': 'req-1',
    });
    expect(init.body).toBe('{"plan_id":"P-1"}');
  });

  it('sends no body and no request id on a GET', async () => {
    const fetchMock = stubFetch(() => json(200, { id: 'I-1' }));
    await new FetchPaypalSubscriptionHttpClient().request({
      method: 'GET',
      path: `${SUBSCRIPTIONS}/I-1`,
      accessToken: TOKEN,
    });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.body).toBeUndefined();
    expect(init.headers['PayPal-Request-Id']).toBeUndefined();
  });

  it('maps a 204 with an empty body to an empty object', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const response = await new FetchPaypalSubscriptionHttpClient().request({
      method: 'POST',
      path: `${SUBSCRIPTIONS}/I-1/cancel`,
      accessToken: TOKEN,
      body: { reason: 'r' },
    });
    expect(response).toEqual({ status: 204, body: {}, debugId: null });
  });

  it('returns 4xx and 5xx JSON error bodies with the debug id for the executor to map', async () => {
    for (const status of [400, 404, 422, 500, 503]) {
      stubFetch(() =>
        json(status, { name: 'ERR', debug_id: 'abc' }, { 'paypal-debug-id': `dbg-${status}` }),
      );
      const response = await new FetchPaypalSubscriptionHttpClient().request({
        method: 'GET',
        path: `${SUBSCRIPTIONS}/I-1`,
        accessToken: TOKEN,
      });
      expect(response).toEqual({
        status,
        body: { name: 'ERR', debug_id: 'abc' },
        debugId: `dbg-${status}`,
      });
    }
  });

  it('keeps at most 200 characters of a non-JSON body', async () => {
    stubFetch(() => new Response(`<html>${'x'.repeat(500)}</html>`, { status: 502 }));
    const response = await new FetchPaypalSubscriptionHttpClient().request({
      method: 'GET',
      path: `${SUBSCRIPTIONS}/I-1`,
      accessToken: TOKEN,
    });
    expect(response.status).toBe(502);
    expect(String(response.body['raw'])).toHaveLength(200);
  });

  it('times out with a sanitized, retryable uncertain error', async () => {
    hangingFetch();
    const error = await new FetchPaypalSubscriptionHttpClient(10)
      .request({ method: 'GET', path: `${SUBSCRIPTIONS}/I-1`, accessToken: TOKEN })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNCERTAIN',
      message: 'PayPal subscription HTTP request timed out',
      retryable: true,
      uncertain: true,
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('sanitizes a network failure without the token or URL internals', async () => {
    stubFetch(() => {
      throw new TypeError(`fetch failed Authorization: Bearer ${TOKEN}`);
    });
    const error = await new FetchPaypalSubscriptionHttpClient()
      .request({ method: 'GET', path: `${SUBSCRIPTIONS}/I-1`, accessToken: TOKEN })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNCERTAIN',
      message: 'PayPal subscription request failed due to a network error',
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe('FetchPaypalOAuthHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const basic = { Authorization: 'Basic Y2xpZW50OnNlY3JldA==' };

  it('posts the form and parses the token response', async () => {
    const fetchMock = stubFetch(() =>
      json(200, { access_token: 'tok', expires_in: 32_400 }, { 'paypal-debug-id': 'dbg-o' }),
    );
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    const response = await new FetchPaypalOAuthHttpClient().postForm(OAUTH, form, basic, 5_000);
    expect(response).toEqual({
      status: 200,
      body: { access_token: 'tok', expires_in: 32_400 },
      debugId: 'dbg-o',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OAUTH);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers).toBe(basic);
  });

  it('maps an empty 204 body to an empty object', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const response = await new FetchPaypalOAuthHttpClient().postForm(
      OAUTH,
      new URLSearchParams(),
      basic,
      5_000,
    );
    expect(response).toEqual({ status: 204, body: {}, debugId: null });
  });

  it('returns 401 and 500 JSON bodies as data', async () => {
    for (const status of [401, 500]) {
      stubFetch(() => json(status, { error: 'invalid_client' }));
      const response = await new FetchPaypalOAuthHttpClient().postForm(
        OAUTH,
        new URLSearchParams(),
        basic,
        5_000,
      );
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error: 'invalid_client' });
    }
  });

  it('keeps at most 200 characters of a non-JSON body', async () => {
    stubFetch(() => new Response('y'.repeat(1_000), { status: 503 }));
    const response = await new FetchPaypalOAuthHttpClient().postForm(
      OAUTH,
      new URLSearchParams(),
      basic,
      5_000,
    );
    expect(String(response.body['raw'])).toHaveLength(200);
  });

  it('times out with a sanitized, retryable error that does not carry credentials', async () => {
    hangingFetch();
    const error = await new FetchPaypalOAuthHttpClient()
      .postForm(OAUTH, new URLSearchParams(), basic, 10)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNCERTAIN',
      message: 'PayPal OAuth request timed out',
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain('Y2xpZW50OnNlY3JldA');
  });
});

describe('live PayPal HTTP clients never follow redirects with credentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const calls: Array<[string, () => Promise<unknown>]> = [
    [
      'oauth',
      () => new FetchPaypalOAuthHttpClient().postForm(OAUTH, new URLSearchParams(), {}, 5_000),
    ],
    [
      'subscription',
      () =>
        new FetchPaypalSubscriptionHttpClient().request({
          method: 'GET',
          path: SUBSCRIPTIONS,
          accessToken: TOKEN,
        }),
    ],
    [
      'orders',
      () =>
        new FetchPaypalOrdersHttpClient().request({
          method: 'GET',
          path: SUBSCRIPTIONS,
          accessToken: TOKEN,
        }),
    ],
    [
      'payout',
      () =>
        new FetchPaypalPayoutHttpClient().request({
          method: 'GET',
          path: SUBSCRIPTIONS,
          accessToken: TOKEN,
        }),
    ],
    [
      'seller onboarding',
      () =>
        new FetchPaypalSellerOnboardingHttpClient().request({
          method: 'GET',
          path: SUBSCRIPTIONS,
          accessToken: TOKEN,
          attributionId: 'BN',
        }),
    ],
  ];

  for (const [label, call] of calls) {
    it(`${label}: asks fetch to refuse redirects and maps the refusal to a sanitized error`, async () => {
      const fetchMock = stubFetch((_url, init) => {
        if (init.redirect === 'error') {
          throw new TypeError('fetch failed: unexpected redirect to https://evil.example/');
        }
        return json(200, { followed: true });
      });
      const error = await call().catch((caught: unknown) => caught);
      expect(fetchMock.mock.calls[0]![1].redirect).toBe('error');
      expect(error).toMatchObject({ code: 'PROVIDER_UNCERTAIN', retryable: true });
      expect(JSON.stringify(error)).not.toContain('evil.example');
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    });
  }
});
