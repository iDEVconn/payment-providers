import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyWebhookRequest } from '../../../contracts/index';
import {
  buildOperationIdempotencyScope,
  MemoryPaymentReliabilityStore,
  resolvePaymentRuntime,
  WebhookProcessingService,
} from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { LivePaypalWebhookVerificationClient } from '../live-paypal-webhook-verification-client';
import { PaypalOAuthClient } from '../paypal-oauth-client';
import {
  PaypalWebhookVerifier,
  type PaypalWebhookVerificationClient,
} from '../paypal-webhook-verifier';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

const headers = {
  transmissionId: 'tx-1',
  transmissionTime: '2026-10-22T00:00:00Z',
  certUrl: 'https://api.paypal.com/cert',
  authAlgo: 'SHA256withRSA',
  transmissionSig: 'sig',
};

function runtime() {
  return resolvePaymentRuntime({
    config: sandboxPaypalProviderConfig({
      credentials: { clientId: 'id', clientSecret: 'secret' },
      capabilityFlags: { subscription: true, checkout: true },
    }),
    nodeEnv: 'development',
  });
}

function request(rawBody: string): VerifyWebhookRequest {
  return { ...ctx, webhookId: 'WH-1', rawBody, headers };
}

function clientReturning(status: string): PaypalWebhookVerificationClient {
  return { verifyWebhookSignature: async () => ({ verification_status: status }) };
}

async function seedSubmitted(store: MemoryPaymentReliabilityStore, subscriptionId: string) {
  const operation = await store.createOperation({
    idempotencyKey: subscriptionId,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp',
    ...ctx,
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: subscriptionId,
    providerPlanId: 'P-1',
  });
  return store.transitionOperation({
    operationId: operation.operationId,
    expectedVersion: operation.version,
    nextStatus: 'submitted',
    providerReferenceId: subscriptionId,
    reason: 'seed',
  });
}

function activatedBody(eventId: string, subscriptionId: string): string {
  return JSON.stringify({
    id: eventId,
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: { id: subscriptionId, status: 'ACTIVE' },
  });
}

describe('PaypalWebhookVerifier verification_status mapping', () => {
  const body = JSON.stringify({ id: 'WH-1', event_type: 'X', resource: { id: 'R-1' } });

  it('only FAILURE from a 2xx response is a rejected signature', async () => {
    const result = await new PaypalWebhookVerifier(
      runtime(),
      clientReturning('FAILURE'),
      'development',
    ).verify(request(body));
    expect(result).toMatchObject({ verified: false, failureKind: 'signature_rejected' });
  });

  it('an unknown verification_status is verification_unavailable', async () => {
    const result = await new PaypalWebhookVerifier(
      runtime(),
      clientReturning('PENDING'),
      'development',
    ).verify(request(body));
    expect(result).toMatchObject({ verified: false, failureKind: 'verification_unavailable' });
  });

  it('passes the original raw body to the verification client', async () => {
    const raw = '{"id":"WH-1","amount":1.10,"event_type":"X","resource":{"id":"R-1"}}';
    const verifyWebhookSignature = vi.fn(async () => ({ verification_status: 'SUCCESS' }));
    await new PaypalWebhookVerifier(runtime(), { verifyWebhookSignature }, 'development').verify(
      request(raw),
    );
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ rawWebhookEvent: raw, webhookEvent: JSON.parse(raw) }),
    );
  });

  it('rejects a body that is valid JSON but not an object as invalid_payload', async () => {
    const verifyWebhookSignature = vi.fn(async () => ({ verification_status: 'SUCCESS' }));
    for (const raw of ['[]', 'null', '42', '"text"']) {
      const result = await new PaypalWebhookVerifier(
        runtime(),
        { verifyWebhookSignature },
        'development',
      ).verify(request(raw));
      expect(result).toMatchObject({ verified: false, failureKind: 'invalid_payload' });
    }
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('uses the webhook id configured at build time when the request has none', async () => {
    const verifyWebhookSignature = vi.fn(async () => ({ verification_status: 'SUCCESS' }));
    const result = await new PaypalWebhookVerifier(
      runtime(),
      { verifyWebhookSignature },
      'development',
      { webhookId: 'WH-CONFIGURED' },
    ).verify({ ...request(body), webhookId: '' });
    expect(result.verified).toBe(true);
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 'WH-CONFIGURED' }),
    );
  });
});

describe('webhook verification auth failures keep evidence recoverable (#19, #1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function liveVerifier(oauth: PaypalOAuthClient) {
    return new PaypalWebhookVerifier(
      runtime(),
      new LivePaypalWebhookVerificationClient(
        oauth,
        { accountRef: 'default', environment: 'sandbox' },
        'sandbox',
        1_000,
      ),
      'production',
    );
  }

  const fetchModes: Record<string, [number, string] | 'timeout'> = {
    s401: [401, '{"error":"invalid_token"}'],
    s403: [403, '{"name":"PERMISSION_DENIED"}'],
    s400: [400, '{"name":"VALIDATION_ERROR"}'],
    okNoStatus: [200, '{}'],
    s503: [503, '{}'],
    html502: [502, '<html>bad gateway</html>'],
    timeout: 'timeout',
  };

  for (const [mode, behaviour] of Object.entries(fetchModes)) {
    it(`${mode}: evidence stays pending and a redelivery processes the event`, async () => {
      let failing = true;
      vi.stubGlobal('fetch', async () => {
        if (failing) {
          if (behaviour === 'timeout') {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }
          return new Response(behaviour[1], { status: behaviour[0] });
        }
        return new Response('{"verification_status":"SUCCESS"}', { status: 200 });
      });
      const oauth = new PaypalOAuthClient(
        () => ({ clientId: 'x', clientSecret: 'y', environment: 'sandbox' }),
        {
          postForm: async () => ({ status: 200, body: { access_token: 'tok', expires_in: 3600 } }),
        },
      );
      const verifier = liveVerifier(oauth);
      const store = new MemoryPaymentReliabilityStore();
      const service = new WebhookProcessingService(store);
      await seedSubmitted(store, 'S1');
      const raw = activatedBody('WH-EV-1', 'S1');
      const verify = () => verifier.verify(request(raw));

      await expect(
        service.receiveWebhook({ ...ctx, rawBody: raw, providerEventId: 'WH-EV-1', verify }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
      const evidence = await store.findEvidenceByProviderEvent(
        'paypal',
        'default',
        'sandbox',
        'WH-EV-1',
      );
      expect(evidence).toMatchObject({
        verificationStatus: 'pending',
        processingStatus: 'pending',
        errorCode: 'VERIFICATION_UNAVAILABLE',
      });

      failing = false;
      const receipt = await service.receiveWebhook({
        ...ctx,
        rawBody: raw,
        providerEventId: 'WH-EV-1',
        verify,
      });
      expect(receipt.processingStatus).toBe('processed');
      const operation = await store.findOperationByProviderSubscriptionId(
        'paypal',
        'default',
        'sandbox',
        'S1',
      );
      expect(operation?.subscriptionStatus).toBe('active');
    });
  }

  it('a revoked cached token is evicted: three webhooks are processed after one refresh (p8)', async () => {
    const tokens = ['revoked-token', 'fresh-token'];
    let oauthCalls = 0;
    const authorizations: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string>)['Authorization'] ?? '';
      authorizations.push(authorization);
      return authorization === 'Bearer revoked-token'
        ? new Response('{"name":"AUTHENTICATION_FAILURE"}', { status: 401 })
        : new Response('{"verification_status":"SUCCESS"}', { status: 200 });
    });
    const oauth = new PaypalOAuthClient(
      () => ({ clientId: 'x', clientSecret: 'y', environment: 'sandbox' }),
      {
        postForm: async () => ({
          status: 200,
          body: { access_token: tokens[oauthCalls++] ?? 'unexpected', expires_in: 32_400 },
        }),
      },
    );
    const verifier = liveVerifier(oauth);
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);

    for (let index = 0; index < 3; index += 1) {
      await seedSubmitted(store, `S${index}`);
      const raw = activatedBody(`WH-${index}`, `S${index}`);
      const receipt = await service.receiveWebhook({
        ...ctx,
        rawBody: raw,
        providerEventId: `WH-${index}`,
        verify: () => verifier.verify(request(raw)),
      });
      expect(receipt.processingStatus).toBe('processed');
    }
    expect(oauthCalls).toBe(2);
    expect(authorizations).toEqual([
      'Bearer revoked-token',
      'Bearer fresh-token',
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
  });
});
