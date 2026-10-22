import { describe, expect, it, vi } from 'vitest';
import { PaypalOAuthClient } from '../paypal-oauth-client';

describe('PaypalOAuthClient', () => {
  it('caches tokens per account/environment scope and dedupes inflight refresh', async () => {
    const postForm = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'token-a', expires_in: 3600 },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'token-b', expires_in: 3600 },
      });

    const client = new PaypalOAuthClient(
      () => ({
        clientId: 'id',
        clientSecret: 'secret',
        environment: 'sandbox',
      }),
      { postForm },
      60_000,
    );

    const scopeA = { accountRef: 'acct-a', environment: 'sandbox' as const };
    const scopeB = { accountRef: 'acct-b', environment: 'sandbox' as const };

    const [first, second, third] = await Promise.all([
      client.getAccessToken(scopeA),
      client.getAccessToken(scopeA),
      client.getAccessToken(scopeB),
    ]);

    expect(first).toBe('token-a');
    expect(second).toBe('token-a');
    expect(third).toBe('token-b');
    expect(postForm).toHaveBeenCalledTimes(2);
  });

  it('maps auth failures to non-retryable provider auth errors', async () => {
    const client = new PaypalOAuthClient(
      () => ({
        clientId: 'id',
        clientSecret: 'secret',
        environment: 'sandbox',
      }),
      {
        postForm: vi.fn().mockResolvedValue({
          status: 401,
          body: { error: 'invalid_client' },
        }),
      },
    );

    await expect(
      client.getAccessToken({ accountRef: 'default', environment: 'sandbox' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILURE',
      retryable: false,
    });
  });
});
