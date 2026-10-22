import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../../contracts/index';
import * as subscriptionEvidence from '../subscription-evidence-application';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

const provider: SubscriptionProviderPort = {
  createProduct: async () => ({
    providerProductId: 'PROD-1',
    productStatus: 'created',
  }),
  getProduct: async () => ({
    providerProductId: 'PROD-1',
    productStatus: 'created',
  }),
  createPlan: async () => ({
    providerPlanId: 'PLAN-1',
    providerProductId: 'PROD-1',
    planStatus: 'created',
  }),
  getPlan: async () => ({
    providerPlanId: 'PLAN-1',
    providerProductId: 'PROD-1',
    planStatus: 'active',
  }),
  activatePlan: async () => ({
    providerPlanId: 'PLAN-1',
    providerProductId: 'PROD-1',
    planStatus: 'active',
  }),
  deactivatePlan: async () => ({
    providerPlanId: 'PLAN-1',
    providerProductId: 'PROD-1',
    planStatus: 'inactive',
  }),
  createSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'approval_pending',
    approvalUrl: 'https://paypal.test/approve',
    startTime: null,
    nextBillingTime: null,
  }),
  getSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'active',
    approvalUrl: null,
    startTime: '2026-01-01T00:00:00.000Z',
    nextBillingTime: '2026-02-01T00:00:00.000Z',
  }),
  cancelSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'cancelled',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: 'cancelled',
  }),
  suspendSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'suspended',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: 'suspended',
  }),
  activateSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'active',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: 'active',
  }),
};

async function seedBillingPlan(store: MemoryPaymentReliabilityStore) {
  const scope = buildOperationIdempotencyScope({
    applicationRef: 'test-app',
    accountRef: 'default',
    environment: 'sandbox',
    kind: 'billing_plan',
  });
  const plan = await store.createOperation({
    idempotencyKey: 'plan-seed',
    idempotencyScope: scope,
    commandFingerprint: 'fp-plan',
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox',
    kind: 'billing_plan',
    providerPlanId: 'PLAN-1',
    planStatus: 'active',
  });
  await store.transitionOperation({
    operationId: plan.operationId,
    expectedVersion: 1,
    nextStatus: 'succeeded',
    reason: 'seed plan',
  });
  return plan;
}

describe('SubscriptionLifecycleService', () => {
  it('creates catalog product before provider mutation and persists provider product id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const result = await service.createCatalogProduct({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'prod-idem-1',
      name: 'Premium',
      type: 'SERVICE',
    });

    expect(result.providerProductId).toBe('PROD-1');
    const operation = await store.findOperationByProviderProductId(
      'paypal',
      'default',
      'sandbox',
      'PROD-1',
    );
    expect(operation?.status).toBe('succeeded');
  });

  it('reuses product operation for repeated idempotency key', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const input = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'prod-idem-2',
      name: 'Premium',
      type: 'SERVICE' as const,
    };
    const first = await service.createCatalogProduct(input);
    const second = await service.createCatalogProduct(input);
    expect(first.productOperationId).toBe(second.productOperationId);
  });

  it('marks provider timeout as unknown instead of failed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const uncertainProvider: SubscriptionProviderPort = {
      ...provider,
      createProduct: vi.fn().mockRejectedValue({
        uncertain: true,
        code: 'PROVIDER_TIMEOUT',
        message: 'timeout',
      }),
    };
    const service = new SubscriptionLifecycleService(store, uncertainProvider);
    const result = await service.createCatalogProduct({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'prod-timeout',
      name: 'Premium',
      type: 'SERVICE',
    });
    expect(result.operationStatus).toBe('unknown');
  });

  it('activates and deactivates billing plans through durable lifecycle operations', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const product = await service.createCatalogProduct({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'prod-plan-life',
      name: 'Premium',
      type: 'SERVICE',
    });
    const plan = await service.createBillingPlan({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'plan-life',
      productOperationId: product.productOperationId,
      name: 'Monthly',
      status: 'CREATED',
      billingCycles: [
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 1,
          price: { currency: 'USD', amountMinor: '999' },
        },
      ],
      paymentPreferences: { auto_bill_outstanding: true },
    });

    const activated = await service.activateBillingPlan({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'plan-activate',
      planOperationId: plan.planOperationId,
    });
    expect(activated.planStatus).toBe('active');

    const deactivated = await service.deactivateBillingPlan({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'plan-deactivate',
      planOperationId: plan.planOperationId,
    });
    expect(deactivated.planStatus).toBe('inactive');
  });

  it('copies billing-plan offeringRef onto the canonical subscription operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, {
      ...provider,
      getPlan: async (input) => ({
        providerPlanId: input.providerPlanId,
        providerProductId: 'PROD-1',
        planStatus: 'active',
      }),
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'billing_plan',
    });
    const plan = await store.createOperation({
      idempotencyKey: 'plan-offering',
      idempotencyScope: scope,
      commandFingerprint: 'fp-plan-offering',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'billing_plan',
      providerPlanId: 'PLAN-OFFERING',
      offeringRef: 'campaign_creator_individual_monthly_v1',
      planStatus: 'active',
    });
    await store.transitionOperation({
      operationId: plan.operationId,
      expectedVersion: 1,
      nextStatus: 'succeeded',
      reason: 'seed plan with offering',
    });

    const result = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-offering-copy',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-offering' },
    });

    const subscription = await store.findOperationById(result.subscriptionOperationId);
    expect(subscription?.offeringRef).toBe('campaign_creator_individual_monthly_v1');
  });

  it('keeps subscription offeringRef null when the billing plan offeringRef is null', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);

    const result = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-null-offering',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-null-offering' },
    });

    const subscription = await store.findOperationById(result.subscriptionOperationId);
    expect(subscription?.offeringRef).toBeNull();
  });

  it('replays idempotent create with the same canonical subscription operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const input = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'sub-idem-replay',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-replay' },
    };
    const first = await service.createSubscription(input);
    const second = await service.createSubscription(input);
    expect(second.subscriptionOperationId).toBe(first.subscriptionOperationId);
  });

  it('creates a subscription with approval URL and masked subscriber', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const result = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-idem-1',
      planOperationId: plan.operationId,
      subscriber: {
        subscriberRef: 'user-123',
        email: 'subscriber@example.com',
      },
    });

    expect(result.subscriptionStatus).toBe('approval_pending');
    expect(result.approvalUrl).toBe('https://paypal.test/approve');
    expect(result.maskedSubscriber).toBe('su***@example.com');
    expect(result.maskedSubscriber).not.toContain('subscriber@example.com');
  });

  it('rejects idempotency conflicts without echoing subscriber email', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const base = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'sub-idem-2',
      planOperationId: plan.operationId,
      subscriber: {
        subscriberRef: 'user-123',
        email: 'first@example.com',
      },
    };
    await service.createSubscription(base);

    await expect(
      service.createSubscription({
        ...base,
        subscriber: {
          subscriberRef: 'user-456',
          email: 'first@example.com',
        },
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
  });

  it('getSubscription is read-only and does not call provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const lookupProvider: SubscriptionProviderPort = {
      ...provider,
      getSubscription: vi.fn(),
    };
    const service = new SubscriptionLifecycleService(store, lookupProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-readonly',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-readonly' },
    });

    const result = await service.getSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      subscriptionOperationId: created.subscriptionOperationId,
    });

    expect(result.providerSubscriptionId).toBe('SUB-1');
    expect(lookupProvider.getSubscription).not.toHaveBeenCalled();
  });

  it('runs suspend and activate lifecycle mutations idempotently', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-life',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-life' },
    });

    const suspended = await service.suspendSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-suspend',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'Past due',
    });
    expect(suspended.subscriptionStatus).toBe('suspended');

    const reactivated = await service.activateSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-activate',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'Payment received',
    });
    expect(reactivated.subscriptionStatus).toBe('active');
  });

  it('marks lifecycle command succeeded independently of refreshed subscription status', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-command-status',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-command-status' },
    });

    await service.cancelSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-cancel-command',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'User requested cancellation',
    });

    const commandOps = await store.listOperationsByParent(created.subscriptionOperationId);
    const cancelCommand = commandOps.find((op) => op.kind === 'subscription_cancel');
    expect(cancelCommand?.status).toBe('succeeded');
    expect(cancelCommand?.subscriptionStatus).not.toBe('cancelled');
  });

  it('keeps lifecycle command success when post-refresh plan id mismatches stored plan', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const mismatchProvider: SubscriptionProviderPort = {
      ...provider,
      cancelSubscription: async () => ({
        providerSubscriptionId: 'SUB-1',
        providerPlanId: 'PLAN-OTHER',
        subscriptionStatus: 'cancelled',
        approvalUrl: null,
        startTime: '2099-01-01T00:00:00.000Z',
        nextBillingTime: '2099-02-01T00:00:00.000Z',
        lifecycleReason: 'User requested cancellation',
        providerSubscriptionStateAt: '2099-01-01T00:00:00.000Z',
      }),
    };
    const service = new SubscriptionLifecycleService(store, mismatchProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-plan-mismatch-refresh',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-plan-mismatch' },
    });
    const before = await store.findOperationById(created.subscriptionOperationId);

    const result = await service.cancelSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-cancel-plan-mismatch',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'User requested cancellation',
    });

    const commandOps = await store.listOperationsByParent(created.subscriptionOperationId);
    const cancelCommand = commandOps.find((op) => op.kind === 'subscription_cancel');
    expect(cancelCommand?.status).toBe('succeeded');

    // T6a fix wave (review finding 1): the reducer rule, a cancellation on another plan applies;
    // the plan mismatch is reported to the hook and the stored plan is kept.
    expect(result.subscriptionStatus).toBe('cancelled');
    expect(result.providerPlanId).toBe(before?.providerPlanId);

    const after = await store.findOperationById(created.subscriptionOperationId);
    expect(after?.providerPlanId).toBe(before?.providerPlanId);
    expect(after?.subscriptionStatus).toBe('cancelled');
  });

  it('returns refresh pending when provider POST succeeds but GET refresh does not', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const refreshPendingProvider: SubscriptionProviderPort = {
      ...provider,
      cancelSubscription: async () => ({
        providerSubscriptionId: 'SUB-1',
        subscriptionStateRefreshPending: true,
        subscriptionStateRefreshErrorCode: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        lifecycleReason: 'User requested cancellation',
      }),
    };
    const service = new SubscriptionLifecycleService(store, refreshPendingProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-refresh-pending',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-refresh-pending' },
    });
    const beforeStatus = created.subscriptionStatus;

    const result = await service.cancelSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-cancel-refresh-pending',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'User requested cancellation',
    });

    expect(result.subscriptionStateRefreshPending).toBe(true);
    expect(result.subscriptionStatus).toBe(beforeStatus);
    expect(result.subscriptionStateRefreshErrorCode).toBe(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
    );
  });

  it('surfaces normalized command failure when provider POST fails', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const failingProvider: SubscriptionProviderPort = {
      ...provider,
      cancelSubscription: async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          message: 'PayPal rejected cancellation',
          retryable: false,
          uncertain: false,
        };
      },
    };
    const service = new SubscriptionLifecycleService(store, failingProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-post-fail',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-post-fail' },
    });

    await expect(
      service.cancelSubscription({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        idempotencyKey: 'sub-cancel-post-fail',
        subscriptionOperationId: created.subscriptionOperationId,
        reason: 'User requested cancellation',
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
    });
  });

  it('surfaces unknown command outcome when provider POST times out', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const uncertainProvider: SubscriptionProviderPort = {
      ...provider,
      cancelSubscription: async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal subscription cancel failed',
          retryable: true,
          uncertain: true,
        };
      },
    };
    const service = new SubscriptionLifecycleService(store, uncertainProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-post-timeout',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-post-timeout' },
    });

    await expect(
      service.cancelSubscription({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        idempotencyKey: 'sub-cancel-timeout',
        subscriptionOperationId: created.subscriptionOperationId,
        reason: 'User requested cancellation',
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
    });
  });

  it('persists provider subscription state timestamp with refreshed status', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const timestampProvider: SubscriptionProviderPort = {
      ...provider,
      cancelSubscription: async () => ({
        providerSubscriptionId: 'SUB-1',
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'cancelled',
        approvalUrl: null,
        startTime: null,
        nextBillingTime: null,
        lifecycleReason: 'User requested cancellation',
        providerSubscriptionStateAt: '2026-10-20T12:00:00.000Z',
      }),
    };
    const service = new SubscriptionLifecycleService(store, timestampProvider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-watermark',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-watermark' },
    });

    await service.cancelSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-cancel-watermark',
      subscriptionOperationId: created.subscriptionOperationId,
      reason: 'User requested cancellation',
    });

    const updated = await store.findOperationById(created.subscriptionOperationId);
    expect(updated?.subscriptionStatus).toBe('cancelled');
    expect(updated?.providerSubscriptionStateAt).toBe('2026-10-20T12:00:00.000Z');
  });

  it('does not mark provider command failed when persistence fails after POST success', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SubscriptionLifecycleService(store, provider);
    const plan = await seedBillingPlan(store);
    const created = await service.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'sub-persist-fail',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-persist-fail' },
    });

    const persistSpy = vi
      .spyOn(subscriptionEvidence, 'applySubscriptionEvents')
      .mockRejectedValueOnce(
        new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
          'Subscription persistence failed',
        ),
      );

    await expect(
      service.cancelSubscription({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        idempotencyKey: 'sub-cancel-persist-fail',
        subscriptionOperationId: created.subscriptionOperationId,
        reason: 'User requested cancellation',
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
    });

    const commandOps = await store.listOperationsByParent(created.subscriptionOperationId);
    const cancelCommand = commandOps.find((op) => op.kind === 'subscription_cancel');
    expect(cancelCommand?.status).toBe('succeeded');
    persistSpy.mockRestore();
  });
});
