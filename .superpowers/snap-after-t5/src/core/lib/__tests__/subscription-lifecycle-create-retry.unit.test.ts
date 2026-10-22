import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
} from '../../../contracts/index';
import { buildCommandFingerprint } from '../command-fingerprint';
import { CHECKOUT_CREATE_EXECUTION_LEASE_MS } from '../checkout-create-execution-lease';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import {
  SubscriptionLifecycleService,
  type SubscriptionCreateRetryOptions,
} from '../subscription-lifecycle-service';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

function fakeProvider(): SubscriptionProviderPort {
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
    createSubscription: vi.fn().mockResolvedValue({
      providerSubscriptionId: 'SUB-RETRY-1',
      providerPlanId: 'PLAN-1',
      subscriptionStatus: 'approval_pending',
      approvalUrl: 'https://sandbox.paypal.com/approve/sub-retry-1',
      startTime: null,
      nextBillingTime: null,
    }),
    getSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    suspendSubscription: vi.fn(),
    activateSubscription: vi.fn(),
  };
}

describe('retrySubscriptionCreate', () => {
  const scope = {
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox' as const,
  };
  const subscriber = { subscriberRef: 'user-1', email: 'user@example.com' };

  function createInput(planOperationId: string) {
    return {
      ...scope,
      idempotencyKey: 'sub-idem-retry',
      planOperationId,
      subscriber,
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    };
  }

  const alwaysAllowRetry: SubscriptionCreateRetryOptions = {
    evaluateProviderCreateRetryEligibility: () => 'allowed',
  };

  async function seedPlan(store: MemoryPaymentReliabilityStore) {
    const planScope = buildOperationIdempotencyScope({
      applicationRef: scope.applicationRef,
      accountRef: scope.accountRef,
      environment: scope.environment,
      kind: 'billing_plan',
    });
    const plan = await store.createOperation({
      idempotencyKey: 'plan-retry-seed',
      idempotencyScope: planScope,
      commandFingerprint: 'fp-plan-retry',
      providerCode: scope.providerCode,
      accountRef: scope.accountRef,
      applicationRef: scope.applicationRef,
      environment: scope.environment,
      kind: 'billing_plan',
      providerPlanId: 'PLAN-1',
      planStatus: 'active',
    });
    await store.transitionOperation({
      operationId: plan.operationId,
      expectedVersion: plan.version,
      nextStatus: 'succeeded',
      reason: 'seed plan',
    });
    return plan;
  }

  function retryPayload(subscriptionOperationId: string, planOperationId: string) {
    return {
      ...scope,
      subscriptionOperationId,
      planOperationId,
      subscriber,
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    };
  }

  async function seedUnknownSubscriptionWithoutProvider(
    store: MemoryPaymentReliabilityStore,
    provider: SubscriptionProviderPort,
  ) {
    const plan = await seedPlan(store);
    provider.createSubscription.mockRejectedValueOnce({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal HTTP request timed out',
      retryable: true,
      uncertain: true,
    });
    const lifecycle = new SubscriptionLifecycleService(store, provider);
    const created = await lifecycle.createSubscription(createInput(plan.operationId));
    expect(created.operationStatus).toBe('unknown');
    expect(created.providerSubscriptionId).toBeNull();
    vi.mocked(provider.createSubscription).mockClear();
    return {
      lifecycle,
      operationId: created.subscriptionOperationId,
      planOperationId: plan.operationId,
    };
  }

  async function seedSubmittedSubscriptionWithoutProvider(store: MemoryPaymentReliabilityStore) {
    const plan = await seedPlan(store);
    const fingerprint = buildCommandFingerprint({
      planOperationId: plan.operationId,
      subscriberRef: subscriber.subscriberRef,
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    });
    const idempotencyScope = buildOperationIdempotencyScope({
      applicationRef: scope.applicationRef,
      accountRef: scope.accountRef,
      environment: scope.environment,
      kind: 'subscription',
    });
    const created = await store.createOperation({
      idempotencyKey: 'sub-seeded-submitted',
      idempotencyScope,
      commandFingerprint: fingerprint,
      providerCode: scope.providerCode,
      accountRef: scope.accountRef,
      applicationRef: scope.applicationRef,
      environment: scope.environment,
      kind: 'subscription',
      parentOperationId: plan.operationId,
      providerPlanId: 'PLAN-1',
      subscriberRef: subscriber.subscriberRef,
      maskedSubscriber: '***',
      subscriptionStatus: 'approval_pending',
    });
    const leased = await store.acquireCheckoutCreateExecutionLease({
      operationId: created.operationId,
      expectedVersion: created.version,
    });
    if (leased.kind !== 'acquired') {
      throw new Error(`expected acquired lease, got ${leased.kind}`);
    }
    return { operationId: created.operationId, planOperationId: plan.operationId };
  }

  function advancePastExecutionLease() {
    vi.advanceTimersByTime(CHECKOUT_CREATE_EXECUTION_LEASE_MS + 1);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not retry on ordinary create replay or getSubscription', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    const replay = await lifecycle.createSubscription(createInput(planOperationId));
    expect(replay.operationStatus).toBe('unknown');
    expect(provider.createSubscription).not.toHaveBeenCalled();

    const loaded = await lifecycle.getSubscription({
      ...scope,
      subscriptionOperationId: operationId,
    });
    expect(loaded.operationStatus).toBe('unknown');
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('reuses the same operation id and parameters on explicit retry', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    const retried = await lifecycle.retrySubscriptionCreate(
      retryPayload(operationId, planOperationId),
      alwaysAllowRetry,
    );

    expect(retried.providerSubscriptionId).toBe('SUB-RETRY-1');
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestId: operationId,
        providerPlanId: 'PLAN-1',
        subscriberEmail: subscriber.email,
      }),
    );
  });

  it('rejects changed retry parameters before calling the provider', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    await expect(
      lifecycle.retrySubscriptionCreate(
        {
          ...retryPayload(operationId, planOperationId),
          subscriber: { subscriberRef: 'other-user' },
        },
        alwaysAllowRetry,
      ),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects wrong scope before calling the provider', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    await expect(
      lifecycle.retrySubscriptionCreate(
        {
          ...retryPayload(operationId, planOperationId),
          accountRef: 'other-account',
        },
        alwaysAllowRetry,
      ),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST });
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('blocks provider call when retry eligibility is unavailable or expired', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    await lifecycle.retrySubscriptionCreate(retryPayload(operationId, planOperationId), {
      evaluateProviderCreateRetryEligibility: () => 'unavailable',
    });
    expect(provider.createSubscription).not.toHaveBeenCalled();

    await lifecycle.retrySubscriptionCreate(retryPayload(operationId, planOperationId), {
      evaluateProviderCreateRetryEligibility: () => 'expired',
    });
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('returns without provider call while execution lease is active', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const lifecycle = new SubscriptionLifecycleService(store, provider);
    const { operationId, planOperationId } = await seedSubmittedSubscriptionWithoutProvider(store);

    const result = await lifecycle.retrySubscriptionCreate(
      retryPayload(operationId, planOperationId),
      alwaysAllowRetry,
    );

    expect(result.operationStatus).toBe('submitted');
    expect(result.providerSubscriptionId).toBeNull();
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('allows only one concurrent retry provider call', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fakeProvider();
    provider.createSubscription
      .mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      })
      .mockImplementation(async () => {
        await gate;
        return {
          providerSubscriptionId: 'SUB-CONCURRENT',
          providerPlanId: 'PLAN-1',
          subscriptionStatus: 'approval_pending' as const,
          approvalUrl: 'https://sandbox.paypal.com/approve/sub-concurrent',
          startTime: null,
          nextBillingTime: null,
        };
      });
    const { lifecycle, operationId, planOperationId } =
      await seedUnknownSubscriptionWithoutProvider(store, provider);

    const first = lifecycle.retrySubscriptionCreate(
      retryPayload(operationId, planOperationId),
      alwaysAllowRetry,
    );
    const second = lifecycle.retrySubscriptionCreate(
      retryPayload(operationId, planOperationId),
      alwaysAllowRetry,
    );
    release();
    await Promise.allSettled([first, second]);

    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('retries after execution lease expiry and keeps timeout outcomes unknown', async () => {
    vi.useFakeTimers();
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const lifecycle = new SubscriptionLifecycleService(store, provider);
    const { operationId, planOperationId } = await seedSubmittedSubscriptionWithoutProvider(store);
    advancePastExecutionLease();
    provider.createSubscription.mockRejectedValueOnce({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal HTTP request timed out',
      retryable: true,
      uncertain: true,
    });

    const retried = await lifecycle.retrySubscriptionCreate(
      retryPayload(operationId, planOperationId),
      alwaysAllowRetry,
    );

    expect(retried.operationStatus).toBe('unknown');
    expect(retried.providerSubscriptionId).toBeNull();
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('rejects stale executor writes and reloads current operation state on conflict', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const { operationId } = await seedUnknownSubscriptionWithoutProvider(store, provider);
    const leased = await store.acquireCheckoutCreateExecutionLease({
      operationId,
      expectedVersion: (await store.findOperationById(operationId))?.version ?? 1,
    });
    if (leased.kind !== 'acquired') {
      throw new Error('expected acquired lease');
    }
    const staleToken = '00000000-0000-4000-8000-000000000000';

    await expect(
      store.transitionOperation({
        operationId,
        expectedVersion: leased.operation.version,
        expectedExecutionOwnerToken: staleToken,
        nextStatus: 'submitted',
        providerSubscriptionId: 'SUB-STALE',
        providerReferenceId: 'SUB-STALE',
        reason: 'Stale owner attempt',
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
      rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH,
    });

    const refreshed = await store.findOperationById(operationId);
    expect(refreshed?.providerSubscriptionId).toBeNull();
  });

  it('preserves checkout create execution lease behavior for checkout operations', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const checkout = await store.createOperation({
      idempotencyKey: 'checkout-lease-kind',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: scope.applicationRef,
        accountRef: scope.accountRef,
        environment: scope.environment,
        kind: 'checkout',
      }),
      commandFingerprint: 'fp-checkout',
      providerCode: scope.providerCode,
      accountRef: scope.accountRef,
      applicationRef: scope.applicationRef,
      environment: scope.environment,
      kind: 'checkout',
      amountMinor: '100',
      currencyCode: 'USD',
    });

    const lease = await store.acquireCheckoutCreateExecutionLease({
      operationId: checkout.operationId,
      expectedVersion: checkout.version,
    });
    expect(lease.kind).toBe('acquired');
    if (lease.kind === 'acquired') {
      const transitions = await store.listOperationTransitions(checkout.operationId);
      expect(transitions.some((row) => row.reason === 'Claimed for provider execution')).toBe(true);
    }
  });
});
