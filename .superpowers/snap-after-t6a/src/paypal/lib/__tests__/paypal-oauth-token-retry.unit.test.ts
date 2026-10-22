import { describe, expect, it, vi } from 'vitest';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { sendWithPaypalAccessToken } from '../paypal-access-token-retry';
import {
  PaypalCheckoutExecutor,
  type PaypalCheckoutTokenProvider,
} from '../paypal-checkout-executor';
import { PaypalMarketplaceExecutor } from '../paypal-marketplace-executor';
import { PaypalOAuthClient, type PaypalOAuthCredentials } from '../paypal-oauth-client';
import { PaypalPayoutExecutor } from '../paypal-payout-executor';
import { PaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor';
import { PaypalSubscriptionExecutor } from '../paypal-subscription-executor';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};
const scope = { accountRef: 'default', environment: 'sandbox' as const };

function tokenResponses(...tokens: string[]) {
  const postForm = vi.fn();
  for (const token of tokens) {
    postForm.mockResolvedValueOnce({
      status: 200,
      body: { access_token: token, expires_in: 32_400 },
    });
  }
  return postForm;
}

function oauthClient(
  postForm: ReturnType<typeof vi.fn>,
  credentials: () => PaypalOAuthCredentials | null = () => ({
    clientId: 'client-a',
    clientSecret: 'secret',
    environment: 'sandbox',
  }),
) {
  return new PaypalOAuthClient(credentials, { postForm }, 60_000);
}

describe('PaypalOAuthClient token cache', () => {
  it('keys the cache by clientId as well as account and environment', async () => {
    let clientId = 'client-a';
    const postForm = tokenResponses('token-a', 'token-b');
    const client = oauthClient(postForm, () => ({
      clientId,
      clientSecret: 'secret',
      environment: 'sandbox',
    }));

    expect(await client.getAccessToken(scope)).toBe('token-a');
    clientId = 'client-b';
    expect(await client.getAccessToken(scope)).toBe('token-b');
    clientId = 'client-a';
    expect(await client.getAccessToken(scope)).toBe('token-a');
    expect(postForm).toHaveBeenCalledTimes(2);
  });

  it('evicts the rejected token and fetches a fresh one', async () => {
    const postForm = tokenResponses('revoked', 'fresh');
    const client = oauthClient(postForm);

    expect(await client.getAccessToken(scope)).toBe('revoked');
    expect(await client.getAccessToken(scope)).toBe('revoked');
    expect(await client.getAccessToken(scope, { rejectedToken: 'revoked' })).toBe('fresh');
    expect(await client.getAccessToken(scope)).toBe('fresh');
    expect(postForm).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer token when a late caller reports an older rejected token', async () => {
    const postForm = tokenResponses('revoked', 'fresh');
    const client = oauthClient(postForm);

    await client.getAccessToken(scope);
    await client.getAccessToken(scope, { rejectedToken: 'revoked' });
    expect(await client.getAccessToken(scope, { rejectedToken: 'revoked' })).toBe('fresh');
    expect(postForm).toHaveBeenCalledTimes(2);
  });

  it('refreshes once for many concurrent callers that saw the same 401 (single flight)', async () => {
    const postForm = tokenResponses('revoked', 'fresh', 'unexpected');
    const client = oauthClient(postForm);
    await client.getAccessToken(scope);

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => client.getAccessToken(scope, { rejectedToken: 'revoked' })),
    );
    expect(new Set(tokens)).toEqual(new Set(['fresh']));
    expect(postForm).toHaveBeenCalledTimes(2);
  });
});

describe('sendWithPaypalAccessToken', () => {
  it('retries once with a fresh token after a 401', async () => {
    const postForm = tokenResponses('revoked', 'fresh');
    const client = oauthClient(postForm);
    const seen: string[] = [];
    const response = await sendWithPaypalAccessToken(
      (s, options) => client.getAccessToken(s, options),
      scope,
      async (accessToken) => {
        seen.push(accessToken);
        return accessToken === 'revoked' ? { status: 401, body: {} } : { status: 200, body: {} };
      },
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(['revoked', 'fresh']);
  });

  it('does not retry other statuses', async () => {
    const send = vi.fn(async () => ({ status: 403, body: {} }));
    const tokenProvider = vi.fn(async () => 'token');
    const response = await sendWithPaypalAccessToken(tokenProvider, scope, send);
    expect(response.status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable PROVIDER_AUTH_FAILURE on a second 401 without leaking tokens', async () => {
    const postForm = tokenResponses('secret-token-1', 'secret-token-2');
    const client = oauthClient(postForm);
    const send = vi.fn(async () => ({ status: 401, body: {}, debugId: 'dbg-1' }));
    const error = await sendWithPaypalAccessToken(
      (s, options) => client.getAccessToken(s, options),
      scope,
      send,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'PROVIDER_AUTH_FAILURE',
      retryable: false,
      uncertain: false,
      providerDebugId: 'dbg-1',
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(String((error as { message?: string }).message)).not.toContain('secret-token');
  });
});

function runtime(): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context: ctx,
    descriptor: {
      ...ctx,
      capabilities: evaluateCapabilities(
        sandboxPaypalProviderConfig({
          credentials: { clientId: 'set', clientSecret: 'set' },
          capabilityFlags: {
            subscription: true,
            checkout: true,
            refund: true,
            payout: true,
            seller_onboarding: true,
            marketplace_checkout: true,
          },
          partner: {
            merchantId: 'partner-merchant',
            attributionId: 'BN-TEST',
            sellerOnboardingReturnUrl: 'https://example.com/return',
          },
        }),
        ctx,
      ),
    },
    checkoutCredentials: { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' },
  } as ResolvedPaymentRuntime;
}

const sellerPartnerConfig = {
  partnerMerchantId: 'PARTNER',
  partnerAttributionId: 'BN',
  returnUrl: 'https://app.example/return',
  products: ['EXPRESS_CHECKOUT'],
  features: ['PAYMENT'],
};

type ExecutorCall = (
  client: { request: (input: { accessToken: string }) => Promise<unknown> },
  tokenProvider: PaypalCheckoutTokenProvider,
) => Promise<unknown>;

const executorCalls: Array<[string, ExecutorCall]> = [
  [
    'subscription',
    (client, tokens) =>
      new PaypalSubscriptionExecutor(runtime(), client as never, tokens).getSubscription({
        ...ctx,
        providerSubscriptionId: 'I-1',
      }),
  ],
  [
    'checkout',
    (client, tokens) =>
      new PaypalCheckoutExecutor(runtime(), () => ({}) as never, client as never, tokens).getRefund(
        { ...ctx, providerRefundId: 'R-1' },
      ),
  ],
  [
    'marketplace',
    (client, tokens) =>
      new PaypalMarketplaceExecutor(runtime(), client as never, tokens, {
        partnerAttributionId: 'BN-TEST',
      }).getRefund({ ...ctx, providerRefundId: 'R-1' }),
  ],
  [
    'payout',
    (client, tokens) =>
      new PaypalPayoutExecutor(runtime(), client as never, tokens).getBatch({
        ...ctx,
        providerPayoutBatchId: 'B-1',
      }),
  ],
  [
    'seller onboarding',
    (client, tokens) =>
      new PaypalSellerOnboardingExecutor(
        runtime(),
        client as never,
        tokens,
        sellerPartnerConfig as never,
      ).getMerchantStatus({ ...ctx, providerMerchantId: 'M-1' } as never),
  ],
];

describe('PayPal executors retry once with a fresh token after HTTP 401', () => {
  for (const [label, call] of executorCalls) {
    it(`${label}: evicts the revoked token and retries the call once`, async () => {
      const postForm = tokenResponses('revoked', 'fresh');
      const oauth = oauthClient(postForm);
      const seen: string[] = [];
      const client = {
        request: async (input: { accessToken: string }) => {
          seen.push(input.accessToken);
          return input.accessToken === 'revoked'
            ? { status: 401, body: { error: 'invalid_token' } }
            : { status: 404, body: {} };
        },
      };
      const error = await call(client, (s, options) => oauth.getAccessToken(s, options)).catch(
        (caught: unknown) => caught,
      );
      expect(seen).toEqual(['revoked', 'fresh']);
      expect(postForm).toHaveBeenCalledTimes(2);
      expect((error as { code?: string } | undefined)?.code).not.toBe('PROVIDER_AUTH_FAILURE');
    });

    it(`${label}: a second 401 is PROVIDER_AUTH_FAILURE`, async () => {
      const postForm = tokenResponses('revoked-1', 'revoked-2', 'unused');
      const oauth = oauthClient(postForm);
      const seen: string[] = [];
      const client = {
        request: async (input: { accessToken: string }) => {
          seen.push(input.accessToken);
          return { status: 401, body: { error: 'invalid_token' } };
        },
      };
      const error = await call(client, (s, options) => oauth.getAccessToken(s, options)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'PROVIDER_AUTH_FAILURE', retryable: false });
      expect(seen).toEqual(['revoked-1', 'revoked-2']);
      expect(JSON.stringify(error)).not.toContain('revoked-');
    });
  }
});

describe('the 401 resend keeps the same PayPal-Request-Id', () => {
  function recordingClient() {
    const requests: Array<{ accessToken: string; requestId?: string | null }> = [];
    return {
      requests,
      client: {
        request: async (input: { accessToken: string; requestId?: string | null }) => {
          requests.push({ accessToken: input.accessToken, requestId: input.requestId });
          return input.accessToken === 'revoked'
            ? { status: 401, body: {} }
            : { status: 500, body: {} };
        },
      },
    };
  }

  it('subscription createSubscription', async () => {
    const oauth = oauthClient(tokenResponses('revoked', 'fresh'));
    const { requests, client } = recordingClient();
    await new PaypalSubscriptionExecutor(runtime(), client as never, (s, options) =>
      oauth.getAccessToken(s, options),
    )
      .createSubscription({
        ...ctx,
        providerRequestId: 'REQ-1',
        providerPlanId: 'P-1',
        subscriberEmail: 'subscriber@example.com',
      })
      .catch(() => undefined);
    expect(requests).toEqual([
      { accessToken: 'revoked', requestId: 'REQ-1' },
      { accessToken: 'fresh', requestId: 'REQ-1' },
    ]);
  });

  it('checkout captureOrder', async () => {
    const oauth = oauthClient(tokenResponses('revoked', 'fresh'));
    const { requests, client } = recordingClient();
    await new PaypalCheckoutExecutor(
      runtime(),
      () => ({}) as never,
      client as never,
      (s, options) => oauth.getAccessToken(s, options),
    )
      .captureOrder({ ...ctx, providerRequestId: 'REQ-2', providerOrderId: 'O-1' })
      .catch(() => undefined);
    expect(requests).toEqual([
      { accessToken: 'revoked', requestId: 'REQ-2' },
      { accessToken: 'fresh', requestId: 'REQ-2' },
    ]);
  });
});
