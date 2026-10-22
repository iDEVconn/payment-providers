import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CreateSubscriptionRequest,
  type PlanStatus,
} from '../../../contracts/index';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import type { SubscriptionProviderPort } from '../subscription-provider-port';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox',
} as const;

function makeProvider(overrides: Partial<SubscriptionProviderPort> & { planStatus?: PlanStatus } = {}) {
  const { planStatus = 'active', ...rest } = overrides;
  return {
    createProduct: vi.fn(),
    getProduct: vi.fn(),
    createPlan: vi.fn(),
    getPlan: vi.fn(async (input: { providerPlanId: string }) => ({
      providerPlanId: input.providerPlanId,
      providerProductId: 'PROD-1',
      planStatus,
      name: 'Plan',
    })),
    activatePlan: vi.fn(),
    deactivatePlan: vi.fn(),
    createSubscription: vi.fn(async (input: { providerPlanId: string }) => ({
      providerSubscriptionId: 'I-SUB1',
      providerPlanId: input.providerPlanId,
      subscriptionStatus: 'approval_pending' as const,
      approvalUrl: 'https://paypal.test/approve',
      startTime: null,
      nextBillingTime: null,
    })),
    getSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    suspendSubscription: vi.fn(),
    activateSubscription: vi.fn(),
    ...rest,
  } as unknown as SubscriptionProviderPort & {
    getPlan: ReturnType<typeof vi.fn>;
    createSubscription: ReturnType<typeof vi.fn>;
    cancelSubscription: ReturnType<typeof vi.fn>;
  };
}

async function seedPlan(store: MemoryPaymentReliabilityStore) {
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
    providerPlanId: 'P-PLAN-1',
    offeringRef: 'pro_monthly',
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

function providerPlanRequest(extra: Record<string, unknown> = {}): CreateSubscriptionRequest {
  return {
    ...context,
    idempotencyKey: 'sub-key-1',
    providerPlanId: 'P-PLAN-1',
    offeringRef: 'pro_monthly',
    subscriber: { subscriberRef: 'user-1' },
    ...extra,
  } as CreateSubscriptionRequest;
}

describe('createSubscription on the planOperationId path', () => {
  it('checks the provider plan status like the providerPlanId path', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const plan = await seedPlan(store);
    const provider = makeProvider({ planStatus: 'inactive' });
    const service = new SubscriptionLifecycleService(store, provider);

    await expect(
      service.createSubscription({
        ...context,
        idempotencyKey: 'sub-key-1',
        planOperationId: plan.operationId,
        subscriber: { subscriberRef: 'user-1' },
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST });
    expect(provider.getPlan).toHaveBeenCalledWith({ ...context, providerPlanId: 'P-PLAN-1' });
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });

  it('creates the subscription when the provider plan is active and passes the options through', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const plan = await seedPlan(store);
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);

    await service.createSubscription({
      ...context,
      idempotencyKey: 'sub-key-1',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-1' },
      customId: 'user-1:pro',
      brandName: 'Acme',
      userAction: 'SUBSCRIBE_NOW',
    });

    expect(provider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customId: 'user-1:pro',
        brandName: 'Acme',
        userAction: 'SUBSCRIBE_NOW',
      }),
    );
  });

  it('does not re-check the provider plan when a replay returns stored state', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const plan = await seedPlan(store);
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(store, provider);
    const request = {
      ...context,
      idempotencyKey: 'sub-key-1',
      planOperationId: plan.operationId,
      subscriber: { subscriberRef: 'user-1' },
    };
    await service.createSubscription(request);
    await service.createSubscription(request);
    expect(provider.getPlan).toHaveBeenCalledTimes(1);
    expect(provider.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('createSubscription optional fields', () => {
  it('passes customId, shippingPreference, brandName, userAction and productType to the provider', async () => {
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(new MemoryPaymentReliabilityStore(), provider);
    await service.createSubscription(
      providerPlanRequest({
        customId: 'cid',
        shippingPreference: 'GET_FROM_FILE',
        brandName: 'Acme',
        userAction: 'CONTINUE',
        productType: 'PHYSICAL',
        returnUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
      }),
    );
    expect(provider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customId: 'cid',
        shippingPreference: 'GET_FROM_FILE',
        brandName: 'Acme',
        userAction: 'CONTINUE',
        productType: 'PHYSICAL',
        returnUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
      }),
    );
  });

  it('binds the idempotency key to the optional fields', async () => {
    const service = new SubscriptionLifecycleService(
      new MemoryPaymentReliabilityStore(),
      makeProvider(),
    );
    await service.createSubscription(providerPlanRequest({ customId: 'a' }));
    await expect(
      service.createSubscription(providerPlanRequest({ customId: 'b' })),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
    await expect(service.createSubscription(providerPlanRequest())).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
    });
    await expect(
      service.createSubscription(providerPlanRequest({ customId: 'a' })),
    ).resolves.toMatchObject({ providerSubscriptionId: 'I-SUB1' });
  });

  it.each([
    ['customId', 'x'.repeat(128)],
    ['customId', '   '],
    ['brandName', 'y'.repeat(128)],
    ['shippingPreference', 'EVERYWHERE'],
    ['userAction', 'PAY'],
  ])('rejects an invalid %s before any provider call', async (field, value) => {
    const provider = makeProvider();
    const service = new SubscriptionLifecycleService(new MemoryPaymentReliabilityStore(), provider);
    await expect(
      service.createSubscription(providerPlanRequest({ [field]: value })),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST });
    expect(provider.getPlan).not.toHaveBeenCalled();
    expect(provider.createSubscription).not.toHaveBeenCalled();
  });
});

describe('provider failure diagnostics', () => {
  it('keeps the debug id and a readable message when the provider throws a plain object', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      createSubscription: vi.fn(async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          message: 'PayPal rejected subscription creation',
          retryable: false,
          uncertain: false,
          providerDebugId: 'dbg-create-1',
        };
      }),
    });
    const service = new SubscriptionLifecycleService(store, provider);
    const result = await service.createSubscription(providerPlanRequest());
    const operation = await store.findOperationById(result.subscriptionOperationId);
    expect(operation?.failureCode).toBe(PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION);
    expect(operation?.failureMessage).toContain('PayPal rejected subscription creation');
    expect(operation?.failureMessage).toContain('dbg-create-1');
  });

  it('never stores [object Object] for an error without a message', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      createSubscription: vi.fn(async () => {
        throw { code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN, providerDebugId: 'dbg-2' };
      }),
    });
    const result = await new SubscriptionLifecycleService(store, provider).createSubscription(
      providerPlanRequest(),
    );
    const operation = await store.findOperationById(result.subscriptionOperationId);
    expect(operation?.failureMessage).not.toContain('[object Object]');
    expect(operation?.failureMessage).toContain('dbg-2');
  });

  it('puts the debug id on the error thrown by a failed lifecycle command', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = makeProvider({
      cancelSubscription: vi.fn(async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          message: 'PayPal subscription cancel failed',
          retryable: false,
          uncertain: false,
          providerDebugId: 'dbg-422',
        };
      }),
    });
    const service = new SubscriptionLifecycleService(store, provider);
    const created = await service.createSubscription(providerPlanRequest());
    await store.transitionOperation({
      operationId: created.subscriptionOperationId,
      expectedVersion: (await store.findOperationById(created.subscriptionOperationId))!.version,
      nextStatus: 'succeeded',
      subscriptionStatus: 'active',
      reason: 'activated',
    });

    const error = await service
      .cancelSubscription({
        ...context,
        idempotencyKey: 'cancel-1',
        subscriptionOperationId: created.subscriptionOperationId,
        reason: 'user request',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentReliabilityError);
    expect(error).toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
      providerDebugId: 'dbg-422',
    });
    const [commandOp] = (await store.listOperationsByParent(created.subscriptionOperationId)).filter(
      (op) => op.kind === 'subscription_cancel',
    );
    expect(commandOp?.failureMessage).toContain('dbg-422');
  });
});
