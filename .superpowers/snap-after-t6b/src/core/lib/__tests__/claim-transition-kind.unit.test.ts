import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperationTransitionRecord,
} from '../../../contracts/index';
import { evaluatePaypalSubscriptionCreateRetryEligibility } from '../../../paypal/lib/paypal-subscription-create-retry-policy';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { resolveFirstProviderExecutionAt } from '../provider-execution-transition';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import type { SubscriptionProviderPort } from '../subscription-provider-port';

/*
 * Issue #23: the create retry must not depend on the free-text reason a store writes for the
 * claim transition. The claim is identified by the typed `transitionKind`, and for stores that do
 * not record it, by the structural `prepared -> submitted` move.
 */

const scope = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

const request = {
  ...scope,
  idempotencyKey: 'k',
  providerPlanId: 'PLAN-1',
  offeringRef: 'pro',
  subscriber: { subscriberRef: 'u1' },
};

function timeoutThenCreatedProvider(): SubscriptionProviderPort {
  return {
    createProduct: vi.fn(),
    getProduct: vi.fn(),
    createPlan: vi.fn(),
    getPlan: vi.fn().mockResolvedValue({
      providerPlanId: 'PLAN-1',
      providerProductId: 'PROD-1',
      planStatus: 'active',
    }),
    activatePlan: vi.fn(),
    deactivatePlan: vi.fn(),
    createSubscription: vi
      .fn()
      .mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal subscription HTTP request timed out',
        retryable: true,
        uncertain: true,
      })
      .mockResolvedValue({
        providerSubscriptionId: 'SUB-1',
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'approval_pending',
        approvalUrl: 'https://sandbox.paypal.com/approve/sub-1',
        startTime: null,
        nextBillingTime: null,
      }),
    getSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    suspendSubscription: vi.fn(),
    activateSubscription: vi.fn(),
  };
}

/** A host store written from the interface alone: its claim writes its own reason text. */
function storeWithHostClaim(withKind: boolean): MemoryPaymentReliabilityStore {
  const store = new MemoryPaymentReliabilityStore();
  store.claimOperationForExecution = async (input) => {
    const current = await store.findOperationById(input.operationId);
    if (!current || current.version !== input.expectedVersion || current.status !== 'prepared') {
      throw new PaymentReliabilityError(PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT, 'conflict');
    }
    return store.transitionOperation({
      operationId: input.operationId,
      expectedVersion: input.expectedVersion,
      nextStatus: 'submitted',
      reason: 'host: picked up by worker 7',
      ...(withKind ? { transitionKind: 'claim_execution' as const } : {}),
    });
  };
  return store;
}

const retryOptions = {
  evaluateProviderCreateRetryEligibility: (firstAt: string | null) =>
    evaluatePaypalSubscriptionCreateRetryEligibility(firstAt),
};

describe('create retry does not depend on the claim reason text', () => {
  it.each([
    ['with transitionKind', true],
    ['without transitionKind (structural prepared -> submitted)', false],
  ])(
    'retries an unknown create when the store claim writes another reason %s',
    async (_label, withKind) => {
      const store = storeWithHostClaim(withKind);
      const provider = timeoutThenCreatedProvider();
      const lifecycle = new SubscriptionLifecycleService(store, provider);

      const created = await lifecycle.createSubscription(request);
      expect(created.operationStatus).toBe('unknown');

      const retried = await lifecycle.retrySubscriptionCreate(
        {
          ...request,
          subscriptionOperationId: created.subscriptionOperationId,
        },
        retryOptions,
      );
      expect(provider.createSubscription).toHaveBeenCalledTimes(2);
      expect(retried.operationStatus).toBe('submitted');
      expect(retried.providerSubscriptionId).toBe('SUB-1');
    },
  );

  it('the memory store records claim_execution for a claim and claim_retry for a retry lease', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = timeoutThenCreatedProvider();
    const lifecycle = new SubscriptionLifecycleService(store, provider);
    const created = await lifecycle.createSubscription(request);
    await lifecycle.retrySubscriptionCreate(
      { ...request, subscriptionOperationId: created.subscriptionOperationId },
      retryOptions,
    );
    const kinds = (await store.listOperationTransitions(created.subscriptionOperationId)).map(
      (row) => `${row.fromStatus}->${row.toStatus}:${row.transitionKind ?? '-'}`,
    );
    expect(kinds).toEqual([
      'prepared->submitted:claim_execution',
      'submitted->unknown:-',
      'unknown->submitted:claim_retry',
      'submitted->submitted:-',
    ]);
  });
});

describe('resolveFirstProviderExecutionAt', () => {
  const row = (
    over: Partial<PaymentOperationTransitionRecord>,
  ): PaymentOperationTransitionRecord => ({
    transitionId: Math.random().toString(36),
    operationId: 'op',
    fromStatus: 'prepared',
    toStatus: 'submitted',
    evidenceId: null,
    reason: 'anything at all',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('uses the earliest claim_execution transition whatever its reason', () => {
    expect(
      resolveFirstProviderExecutionAt([
        row({
          createdAt: '2026-01-01T00:00:05.000Z',
          transitionKind: 'claim_execution',
        }),
        row({
          fromStatus: 'unknown',
          createdAt: '2026-01-01T00:00:01.000Z',
          transitionKind: 'claim_retry',
        }),
        row({
          createdAt: '2026-01-01T00:00:03.000Z',
          transitionKind: 'claim_execution',
        }),
      ]),
    ).toBe('2026-01-01T00:00:03.000Z');
  });

  it('falls back to an untyped prepared -> submitted move, never to a retry claim', () => {
    expect(
      resolveFirstProviderExecutionAt([
        row({ fromStatus: 'unknown', transitionKind: 'claim_retry' }),
        row({ createdAt: '2026-01-01T00:00:07.000Z', transitionKind: null }),
      ]),
    ).toBe('2026-01-01T00:00:07.000Z');
    expect(
      resolveFirstProviderExecutionAt([row({ fromStatus: 'unknown', toStatus: 'submitted' })]),
    ).toBeNull();
  });

  it('treats an unknown non-null transitionKind like null (structural fallback applies)', () => {
    const unknownKind =
      'CLAIM_EXECUTION' as unknown as PaymentOperationTransitionRecord['transitionKind'];
    expect(
      resolveFirstProviderExecutionAt([
        row({ createdAt: '2026-01-01T00:00:09.000Z', transitionKind: unknownKind }),
      ]),
    ).toBe('2026-01-01T00:00:09.000Z');
    expect(
      resolveFirstProviderExecutionAt([
        row({ fromStatus: 'unknown', transitionKind: unknownKind }),
      ]),
    ).toBeNull();
  });
});

describe('services never branch on free-text transition reasons', () => {
  it('no core module compares a transition reason or uses the old claim reason literal', () => {
    const dir = join(import.meta.dirname, '..');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => {
        const text = readFileSync(join(dir, file), 'utf8');
        return /\.reason\s*===|===\s*\w*\.reason\b|Claimed for provider execution/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
