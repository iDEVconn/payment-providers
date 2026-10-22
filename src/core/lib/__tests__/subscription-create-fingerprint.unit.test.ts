import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  type CreateSubscriptionRequest,
  type ExecuteCreateSubscriptionRequest,
} from '../../../contracts/index';
import { buildCommandFingerprint } from '../command-fingerprint';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';

/*
 * Issue #25: every request-shaping field of a subscription create (the subscriber email included)
 * is part of the command fingerprint, so a replay or retry with the same idempotency key and a
 * different request is IDEMPOTENCY_CONFLICT instead of being sent to PayPal.
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

const base = {
  ...ctx,
  idempotencyKey: 'k',
  providerPlanId: 'P-1',
  offeringRef: 'pro',
  subscriber: { subscriberRef: 'u1', email: 'a@b.c' },
} satisfies CreateSubscriptionRequest;

function provider(firstCreate: 'timeout' | 'ok' = 'timeout') {
  const bodies: ExecuteCreateSubscriptionRequest[] = [];
  const port = {
    getPlan: vi.fn(async () => ({
      providerPlanId: 'P-1',
      providerProductId: 'PROD-1',
      planStatus: 'active' as const,
    })),
    createSubscription: vi.fn(async (input: ExecuteCreateSubscriptionRequest) => {
      bodies.push(input);
      if (firstCreate === 'timeout' && bodies.length === 1) {
        throw Object.assign(new Error('timed out'), {
          code: 'PROVIDER_UNCERTAIN',
          retryable: true,
          uncertain: true,
        });
      }
      return {
        providerSubscriptionId: 'I-1',
        providerPlanId: 'P-1',
        subscriptionStatus: 'approval_pending' as const,
        approvalUrl: 'https://paypal.test/approve/I-1',
        startTime: null,
        nextBillingTime: null,
      };
    }),
  } as unknown as SubscriptionProviderPort;
  return { port, bodies };
}

const allowRetry = { evaluateProviderCreateRetryEligibility: () => 'allowed' as const };

async function rejectionCode(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
}

describe('subscription create fingerprint (issue #25)', () => {
  it('a retry with a different subscriber email is IDEMPOTENCY_CONFLICT and never reaches PayPal (probe p6)', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const { port, bodies } = provider();
    const service = new SubscriptionLifecycleService(store, port);
    const created = await service.createSubscription(base);
    expect(created.operationStatus).toBe('unknown');

    const { idempotencyKey: _key, ...retry } = base;
    expect(
      await rejectionCode(() =>
        service.retrySubscriptionCreate(
          {
            ...retry,
            subscriber: { subscriberRef: 'u1', email: 'other@x.y' },
            subscriptionOperationId: created.subscriptionOperationId,
          },
          allowRetry,
        ),
      ),
    ).toBe(PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT);
    expect(
      await rejectionCode(() =>
        service.retrySubscriptionCreate(
          {
            ...retry,
            subscriber: { subscriberRef: 'u1' },
            subscriptionOperationId: created.subscriptionOperationId,
          },
          allowRetry,
        ),
      ),
    ).toBe(PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT);
    expect(bodies.map((body) => body.subscriberEmail)).toEqual(['a@b.c']);

    const same = await service.retrySubscriptionCreate(
      { ...retry, subscriptionOperationId: created.subscriptionOperationId },
      allowRetry,
    );
    expect(same.providerSubscriptionId).toBe('I-1');
    expect(bodies.map((body) => body.subscriberEmail)).toEqual(['a@b.c', 'a@b.c']);
  });

  it.each([
    ['subscriber email', { subscriber: { subscriberRef: 'u1', email: 'other@x.y' } }],
    ['customId', { customId: 'order-2' }],
    ['shippingPreference', { shippingPreference: 'GET_FROM_FILE' as const }],
    ['brandName', { brandName: 'Other brand' }],
    ['userAction', { userAction: 'CONTINUE' as const }],
    ['productType', { productType: 'PHYSICAL' as const }],
    ['returnUrl', { returnUrl: 'https://other.test/return' }],
    ['cancelUrl', { cancelUrl: 'https://other.test/cancel' }],
    ['plan reference', { providerPlanId: 'P-2' }],
  ])(
    'a replay of the same key with a different %s is IDEMPOTENCY_CONFLICT',
    async (_label, change) => {
      const store = new MemoryPaymentReliabilityStore();
      const { port, bodies } = provider('ok');
      const service = new SubscriptionLifecycleService(store, port);
      await service.createSubscription({
        ...base,
        customId: 'order-1',
        shippingPreference: 'NO_SHIPPING',
        brandName: 'Brand',
        userAction: 'SUBSCRIBE_NOW',
        productType: 'DIGITAL',
        returnUrl: 'https://host.test/return',
        cancelUrl: 'https://host.test/cancel',
      });
      expect(
        await rejectionCode(() =>
          service.createSubscription({
            ...base,
            customId: 'order-1',
            shippingPreference: 'NO_SHIPPING',
            brandName: 'Brand',
            userAction: 'SUBSCRIBE_NOW',
            productType: 'DIGITAL',
            returnUrl: 'https://host.test/return',
            cancelUrl: 'https://host.test/cancel',
            ...change,
          }),
        ),
      ).toBe(PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT);
      expect(bodies.length).toBe(1);
    },
  );

  it('a request without email keeps its T2 fingerprint', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider('ok').port);
    const result = await service.createSubscription({
      ...base,
      subscriber: { subscriberRef: 'u1' },
    });
    expect(
      (await store.findOperationById(result.subscriptionOperationId))?.commandFingerprint,
    ).toBe(
      buildCommandFingerprint({
        providerPlanId: 'P-1',
        offeringRef: 'pro',
        subscriberRef: 'u1',
        returnUrl: null,
        cancelUrl: null,
      }),
    );
  });

  it('an operation stored with the pre-0.3 fingerprint (no email) still replays and retries with the same email', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const { port, bodies } = provider('ok');
    const service = new SubscriptionLifecycleService(store, port);
    const legacy = await store.createOperation({
      ...ctx,
      idempotencyKey: 'k',
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: buildCommandFingerprint({
        providerPlanId: 'P-1',
        offeringRef: 'pro',
        subscriberRef: 'u1',
        returnUrl: null,
        cancelUrl: null,
      }),
      kind: 'subscription',
      providerPlanId: 'P-1',
      offeringRef: 'pro',
      subscriberRef: 'u1',
      subscriberEmail: 'a@b.c',
      subscriptionStatus: 'approval_pending',
    });
    const claimed = await store.claimOperationForExecution({
      operationId: legacy.operationId,
      expectedVersion: legacy.version,
    });
    await store.transitionOperation({
      operationId: claimed.operationId,
      expectedVersion: claimed.version,
      nextStatus: 'unknown',
      reason: 'timeout under 0.2.x',
    });

    const replay = await service.createSubscription(base);
    expect(replay.subscriptionOperationId).toBe(legacy.operationId);
    const { idempotencyKey: _key, ...retry } = base;
    const retried = await service.retrySubscriptionCreate(
      { ...retry, subscriptionOperationId: legacy.operationId },
      allowRetry,
    );
    expect(retried.providerSubscriptionId).toBe('I-1');
    expect(bodies.map((body) => body.subscriberEmail)).toEqual(['a@b.c']);

    // The stored email is the one the legacy request carried: another email is still a conflict.
    expect(
      await rejectionCode(() =>
        service.createSubscription({
          ...base,
          subscriber: { subscriberRef: 'u1', email: 'other@x.y' },
        }),
      ),
    ).toBe(PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT);
  });
});
