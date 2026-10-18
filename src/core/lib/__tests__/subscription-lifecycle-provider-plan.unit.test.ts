import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CreateSubscriptionRequest,
  type PaymentOperation,
} from '../../../contracts/index';
import { buildCommandFingerprint } from '../command-fingerprint';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

const PROVIDER_PLAN_ID = 'P-INDIVIDUALPLAN000000001';
const OFFERING_REF = 'campaign_creator_individual_monthly_v1';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'edc',
  environment: 'sandbox',
} as const;

const subscriptionScope = buildOperationIdempotencyScope({
  applicationRef: context.applicationRef,
  accountRef: context.accountRef,
  environment: context.environment,
  kind: 'subscription',
});

function makeProvider(overrides: Partial<SubscriptionProviderPort> = {}) {
  let subscriptionCounter = 0;
  const provider = {
    createProduct: vi.fn(),
    getProduct: vi.fn(),
    createPlan: vi.fn(),
    getPlan: vi.fn(async (input: { providerPlanId: string }) => ({
      providerPlanId: input.providerPlanId,
      providerProductId: 'PROD-1',
      planStatus: 'active' as const,
      name: 'Individual Creator',
    })),
    activatePlan: vi.fn(),
    deactivatePlan: vi.fn(),
    createSubscription: vi.fn(async (input: { providerPlanId: string }) => {
      subscriptionCounter += 1;
      return {
        providerSubscriptionId: `I-SUB${subscriptionCounter}`,
        providerPlanId: input.providerPlanId,
        subscriptionStatus: 'approval_pending' as const,
        approvalUrl: 'https://paypal.test/approve',
        startTime: null,
        nextBillingTime: null,
      };
    }),
    getSubscription: vi.fn(),
    cancelSubscription: vi.fn(async () => ({
      providerSubscriptionId: 'I-SUB1',
      providerPlanId: PROVIDER_PLAN_ID,
      subscriptionStatus: 'cancelled' as const,
      lifecycleReason: 'cancelled',
      approvalUrl: null,
      startTime: null,
      nextBillingTime: null,
    })),
    suspendSubscription: vi.fn(),
    activateSubscription: vi.fn(),
    ...overrides,
  };
  return provider as typeof provider & SubscriptionProviderPort;
}

function request(overrides: Record<string, unknown> = {}): CreateSubscriptionRequest {
  return {
    ...context,
    idempotencyKey: 'sub-key-1',
    providerPlanId: PROVIDER_PLAN_ID,
    offeringRef: OFFERING_REF,
    subscriber: { subscriberRef: 'advertiser-1' },
    ...overrides,
  } as CreateSubscriptionRequest;
}

function providerPlanFingerprint(subscriberRef: string) {
  return buildCommandFingerprint({
    providerPlanId: PROVIDER_PLAN_ID,
    offeringRef: OFFERING_REF,
    subscriberRef,
    returnUrl: null,
    cancelUrl: null,
  });
}

async function storedSubscription(
  store: MemoryPaymentReliabilityStore,
  operationId: string,
): Promise<PaymentOperation> {
  const operation = await store.findOperationById(operationId);
  if (!operation) {
    throw new Error('subscription operation missing');
  }
  return operation;
}

describe('SubscriptionLifecycleService.createSubscription with providerPlanId', () => {
  it('creates a subscription without any catalog_product or billing_plan parent', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);

    const result = await service.createSubscription(request());

    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.getPlan).toHaveBeenCalledWith({
      ...context,
      providerPlanId: PROVIDER_PLAN_ID,
    });
    expect(provider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        ...context,
        providerPlanId: PROVIDER_PLAN_ID,
        providerRequestId: result.subscriptionOperationId,
      }),
    );
    expect(result).toMatchObject({
      operationStatus: 'submitted',
      subscriptionStatus: 'approval_pending',
      providerPlanId: PROVIDER_PLAN_ID,
      providerSubscriptionId: 'I-SUB1',
    });

    const operation = await storedSubscription(store, result.subscriptionOperationId);
    expect(operation).toMatchObject({
      kind: 'subscription',
      parentOperationId: null,
      providerPlanId: PROVIDER_PLAN_ID,
      offeringRef: OFFERING_REF,
      subscriberRef: 'advertiser-1',
      ...context,
      idempotencyScope: subscriptionScope,
      idempotencyKey: 'sub-key-1',
      commandFingerprint: providerPlanFingerprint('advertiser-1'),
      providerSubscriptionId: 'I-SUB1',
    });
    expect(
      await store.findOperationByProviderPlanId(
        context.providerCode,
        context.accountRef,
        context.environment,
        PROVIDER_PLAN_ID,
      ),
    ).toBeNull();
    expect(provider.createProduct).not.toHaveBeenCalled();
    expect(provider.createPlan).not.toHaveBeenCalled();
  });

  it.each(['created', 'inactive', 'unknown'] as const)(
    'rejects a %s provider plan before creating an operation',
    async (planStatus) => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = makeProvider({
        getPlan: vi.fn(async () => ({
          providerPlanId: PROVIDER_PLAN_ID,
          providerProductId: 'PROD-1',
          planStatus,
          name: null,
        })),
      });
      const service = new SubscriptionLifecycleService(store, provider);

      await expect(service.createSubscription(request())).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      });
      expect(provider.createSubscription).not.toHaveBeenCalled();
      expect(await store.findOperationByIdempotency(subscriptionScope, 'sub-key-1')).toBeNull();
    },
  );

  it('rejects a provider read that returns a different plan id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      getPlan: vi.fn(async () => ({
        providerPlanId: 'P-OTHERPLAN',
        providerProductId: 'PROD-1',
        planStatus: 'active' as const,
        name: null,
      })),
    });
    const service = new SubscriptionLifecycleService(store, provider);

    await expect(service.createSubscription(request())).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
    });
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('propagates a provider plan read failure without creating an operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      getPlan: vi.fn(async () => {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          'Plan not found',
        );
      }),
    });
    const service = new SubscriptionLifecycleService(store, provider);

    await expect(service.createSubscription(request())).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
    });
    expect(await store.findOperationByIdempotency(subscriptionScope, 'sub-key-1')).toBeNull();
  });

  it.each([
    ['both reference forms', { planOperationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['plan operation with offeringRef', { providerPlanId: undefined, planOperationId: 'x' }],
    ['missing offeringRef', { offeringRef: undefined }],
    ['blank offeringRef', { offeringRef: '  ' }],
    ['missing providerPlanId', { providerPlanId: undefined }],
    ['blank providerPlanId', { providerPlanId: '' }],
    ['no reference at all', { providerPlanId: undefined, offeringRef: undefined }],
  ])('rejects %s with INVALID_REQUEST', async (_label, overrides) => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);

    await expect(service.createSubscription(request(overrides))).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
    });
    expect(provider.getPlan).not.toHaveBeenCalled();
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });
});

describe('legacy planOperationId compatibility', () => {
  it('still resolves the billing_plan parent and keeps its fingerprint and offeringRef', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await store.createOperation({
      idempotencyKey: 'plan-seed',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: context.applicationRef,
        accountRef: context.accountRef,
        environment: context.environment,
        kind: 'billing_plan',
      }),
      commandFingerprint: 'fp-plan',
      ...context,
      kind: 'billing_plan',
      providerPlanId: 'P-LEGACYPLAN',
      offeringRef: OFFERING_REF,
      planStatus: 'active',
    });

    const result = await service.createSubscription({
      ...context,
      idempotencyKey: 'legacy-sub',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'advertiser-legacy' },
    });

    const operation = await storedSubscription(store, result.subscriptionOperationId);
    expect(operation).toMatchObject({
      parentOperationId: plan.operationId,
      providerPlanId: 'P-LEGACYPLAN',
      offeringRef: OFFERING_REF,
      commandFingerprint: buildCommandFingerprint({
        planOperationId: plan.operationId,
        subscriberRef: 'advertiser-legacy',
        returnUrl: null,
        cancelUrl: null,
      }),
    });
    expect(provider.getPlan).not.toHaveBeenCalled();
  });
});

describe('providerPlanId subscription idempotency', () => {
  it('replays a submitted operation without provider calls', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);

    const first = await service.createSubscription(request());
    const second = await service.createSubscription(request());

    expect(second).toEqual(first);
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('replays a completed (succeeded) operation without provider calls', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      createSubscription: vi.fn(async () => ({
        providerSubscriptionId: 'I-SUBACTIVE',
        providerPlanId: PROVIDER_PLAN_ID,
        subscriptionStatus: 'active' as const,
        approvalUrl: null,
        startTime: '2026-10-16T00:00:00.000Z',
        nextBillingTime: '2026-11-16T00:00:00.000Z',
      })),
    });
    const service = new SubscriptionLifecycleService(store, provider);

    const first = await service.createSubscription(request());
    expect(first.operationStatus).toBe('succeeded');
    const second = await service.createSubscription(request());

    expect(second).toEqual(first);
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not replay an uncertain provider mutation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      createSubscription: vi.fn(async () => {
        throw Object.assign(new Error('timeout'), { uncertain: true });
      }),
    });
    const service = new SubscriptionLifecycleService(store, provider);

    const first = await service.createSubscription(request());
    expect(first.operationStatus).toBe('unknown');
    const second = await service.createSubscription(request());

    expect(second.operationStatus).toBe('unknown');
    expect(second.subscriptionOperationId).toBe(first.subscriptionOperationId);
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('returns a terminally failed operation without retrying the provider', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      createSubscription: vi.fn(async () => {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          'rejected',
        );
      }),
    });
    const service = new SubscriptionLifecycleService(store, provider);

    const first = await service.createSubscription(request());
    expect(first.operationStatus).toBe('failed');
    const second = await service.createSubscription(request());

    expect(second.operationStatus).toBe('failed');
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('continues a prepared operation through claim and execution after revalidating the plan', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);
    const prepared = await store.createOperation({
      idempotencyKey: 'sub-key-1',
      idempotencyScope: subscriptionScope,
      commandFingerprint: providerPlanFingerprint('advertiser-1'),
      ...context,
      kind: 'subscription',
      correlationId: null,
      parentOperationId: null,
      providerPlanId: PROVIDER_PLAN_ID,
      offeringRef: OFFERING_REF,
      subscriberRef: 'advertiser-1',
      subscriberEmail: null,
      maskedSubscriber: 'adv***',
      subscriptionStatus: 'approval_pending',
    });
    expect(prepared.status).toBe('prepared');

    const result = await service.createSubscription(request());

    expect(result.subscriptionOperationId).toBe(prepared.operationId);
    expect(result.operationStatus).toBe('submitted');
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerRequestId: prepared.operationId }),
    );
  });

  it('rejects a reused idempotency key with a different command before any provider call', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);
    await service.createSubscription(request());

    await expect(
      service.createSubscription(request({ subscriber: { subscriberRef: 'advertiser-2' } })),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
    await expect(
      service.createSubscription(request({ offeringRef: 'campaign_creator_company_monthly_v1' })),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('provider reference reuse under kind-scoped uniqueness', () => {
  function canonicalDuplicates(
    operations: PaymentOperation[],
    kind: PaymentOperation['kind'],
    column: 'providerProductId' | 'providerPlanId' | 'providerSubscriptionId',
  ) {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const operation of operations) {
      const value = operation[column];
      if (operation.kind !== kind || !value) continue;
      const key = `${operation.providerCode}|${operation.accountRef}|${operation.environment}|${value}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    return duplicates;
  }

  function unscopedDuplicates(
    operations: PaymentOperation[],
    column: 'providerPlanId' | 'providerSubscriptionId',
  ) {
    const counts = new Map<string, number>();
    for (const operation of operations) {
      const value = operation[column];
      if (!value) continue;
      const key = `${operation.providerCode}|${operation.accountRef}|${operation.environment}|${value}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.values()].filter((count) => count > 1).length;
  }

  it('allows many subscribers on one plan and lifecycle commands that repeat the subscription id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);

    const first = await service.createSubscription(
      request({ idempotencyKey: 'sub-a', subscriber: { subscriberRef: 'advertiser-a' } }),
    );
    const second = await service.createSubscription(
      request({ idempotencyKey: 'sub-b', subscriber: { subscriberRef: 'advertiser-b' } }),
    );
    await service.cancelSubscription({
      ...context,
      idempotencyKey: 'cancel-a',
      subscriptionOperationId: first.subscriptionOperationId,
      reason: 'Advertiser requested subscription cancellation',
    });

    const cancelScope = buildOperationIdempotencyScope({
      applicationRef: context.applicationRef,
      accountRef: context.accountRef,
      environment: context.environment,
      kind: 'subscription_cancel',
    });
    const cancelOperation = await store.findOperationByIdempotency(cancelScope, 'cancel-a');
    const operations = [
      await storedSubscription(store, first.subscriptionOperationId),
      await storedSubscription(store, second.subscriptionOperationId),
      cancelOperation as PaymentOperation,
    ];

    expect(cancelOperation).toMatchObject({
      kind: 'subscription_cancel',
      parentOperationId: first.subscriptionOperationId,
      providerSubscriptionId: 'I-SUB1',
    });
    expect(operations.filter((op) => op.providerPlanId === PROVIDER_PLAN_ID)).toHaveLength(2);

    // Proposed predicates: unique only on the canonical row kind.
    expect(canonicalDuplicates(operations, 'billing_plan', 'providerPlanId')).toEqual([]);
    expect(canonicalDuplicates(operations, 'subscription', 'providerSubscriptionId')).toEqual([]);
    // Current unscoped predicates would reject both shared references.
    expect(unscopedDuplicates(operations, 'providerPlanId')).toBe(1);
    expect(unscopedDuplicates(operations, 'providerSubscriptionId')).toBe(1);

    const correlated = await store.findOperationByProviderSubscriptionId(
      context.providerCode,
      context.accountRef,
      context.environment,
      'I-SUB1',
    );
    expect(correlated?.operationId).toBe(first.subscriptionOperationId);
  });
});
