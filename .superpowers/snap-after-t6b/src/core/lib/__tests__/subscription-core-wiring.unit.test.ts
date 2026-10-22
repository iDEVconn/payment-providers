import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, type PaymentOperation } from '../../../contracts/index';
import type { SubscriptionEffect } from '../../../subscription-core/index';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import {
  SUBSCRIPTION_EFFECTS_HOOK_FAILED,
  readSubscriptionOperationState,
  type SubscriptionEffectsHook,
} from '../subscription-evidence-application';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { WebhookProcessingService } from '../webhook-processing-service';

/*
 * Issue #4: the engine runs every subscription webhook through the pure core
 * (normalise -> reduce), persists what the reducer returns and hands the
 * effects to an optional host hook after the state is stored.
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

let sequence = 0;

async function seedPlan(
  store: MemoryPaymentReliabilityStore,
  price: { amountMinor: string; currencyCode: string } | null = {
    amountMinor: '999',
    currencyCode: 'USD',
  },
): Promise<PaymentOperation> {
  sequence += 1;
  return store.createOperation({
    ...ctx,
    idempotencyKey: `plan-${sequence}`,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'billing_plan' }),
    commandFingerprint: 'fp-plan',
    kind: 'billing_plan',
    planStatus: 'active',
    providerPlanId: `P-${sequence}`,
    amountMinor: price?.amountMinor ?? null,
    currencyCode: price?.currencyCode ?? null,
  });
}

async function seedActiveSubscription(
  store: MemoryPaymentReliabilityStore,
  options: { plan?: PaymentOperation | null; providerPlanId?: string } = {},
): Promise<PaymentOperation> {
  const plan = options.plan === undefined ? await seedPlan(store) : options.plan;
  sequence += 1;
  const created = await store.createOperation({
    ...ctx,
    idempotencyKey: `sub-${sequence}`,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp-sub',
    kind: 'subscription',
    parentOperationId: plan?.operationId ?? null,
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: 'I-1',
    providerReferenceId: 'I-1',
    providerPlanId: options.providerPlanId ?? plan?.providerPlanId ?? 'P-STORED',
  });
  return store.transitionOperation({
    operationId: created.operationId,
    expectedVersion: created.version,
    nextStatus: 'succeeded',
    subscriptionStatus: 'active',
    reason: 'seed active',
  });
}

function receive(service: WebhookProcessingService, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return service.receiveWebhook({
    ...ctx,
    rawBody,
    verify: async () => ({
      verified: true,
      transmissionId: String(body.id),
      eventType: String(body.event_type),
      resourceId: String((body.resource as { id?: string }).id ?? ''),
    }),
  });
}

function saleBody(id: string, saleId: string, total: string, currency = 'USD') {
  return {
    id,
    event_type: 'PAYMENT.SALE.COMPLETED',
    create_time: '2026-10-22T10:00:00Z',
    resource: {
      id: saleId,
      billing_agreement_id: 'I-1',
      amount: { total, currency },
      update_time: '2026-10-22T10:00:00Z',
    },
  };
}

function find(store: MemoryPaymentReliabilityStore) {
  return store.findOperationByProviderSubscriptionId(
    ctx.providerCode,
    ctx.accountRef,
    ctx.environment,
    'I-1',
  );
}

function recordingHook() {
  const calls: Array<{ operationId: string; effects: SubscriptionEffect[]; eventType: string }> =
    [];
  const hook: SubscriptionEffectsHook = (operationId, effects, context) => {
    calls.push({ operationId, effects, eventType: context.eventType });
  };
  return { calls, hook };
}

describe('subscription webhooks on the pure core (#4)', () => {
  it('persists billing fields of an ACTIVATED body without a provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const plan = await seedPlan(store);
    sequence += 1;
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: `sub-${sequence}`,
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: 'fp-sub',
      kind: 'subscription',
      parentOperationId: plan.operationId,
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-1',
      providerPlanId: plan.providerPlanId,
    });
    await store.transitionOperation({
      operationId: created.operationId,
      expectedVersion: created.version,
      nextStatus: 'submitted',
      reason: 'seed',
    });

    const receipt = await receive(service, {
      id: 'WH-ACT',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: {
        id: 'I-1',
        plan_id: plan.providerPlanId,
        status: 'ACTIVE',
        start_time: '2026-10-22T00:00:00Z',
        update_time: '2026-10-22T10:00:00Z',
        billing_info: {
          next_billing_time: '2026-11-22T10:00:00Z',
          last_payment: {
            amount: { currency_code: 'USD', value: '9.99' },
            time: '2026-10-22T10:00:00Z',
          },
          failed_payments_count: 0,
        },
      },
    });

    expect(receipt.processingStatus).toBe('processed');
    const operation = await find(store);
    expect(operation?.subscriptionStatus).toBe('active');
    expect(operation?.status).toBe('succeeded');
    expect(operation?.nextBillingTime).toBe('2026-11-22T10:00:00.000Z');
    expect(operation?.startTime).toBe('2026-10-22T00:00:00.000Z');
    expect(operation?.subscriptionStateJson).toEqual(expect.any(String));
    const state = readSubscriptionOperationState(operation as PaymentOperation);
    expect(state.lastPayment).toEqual({
      amountMinor: '999',
      currency: 'USD',
      time: '2026-10-22T10:00:00.000Z',
    });
    expect(state.failedPaymentsCount).toBe(0);
    expect(state.stateAt).toBe('2026-10-22T10:00:00.000Z');
  });

  it('applies BILLING.SUBSCRIPTION.UPDATED billing fields without a provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const seeded = await seedActiveSubscription(store);

    const receipt = await receive(service, {
      id: 'WH-UPD',
      event_type: 'BILLING.SUBSCRIPTION.UPDATED',
      resource: {
        id: 'I-1',
        status: 'ACTIVE',
        update_time: '2026-10-23T10:00:00Z',
        billing_info: { next_billing_time: '2026-12-22T10:00:00Z' },
      },
    });

    expect(receipt.processingStatus).toBe('processed');
    const operation = await store.findOperationById(seeded.operationId);
    expect(operation?.subscriptionStatus).toBe('active');
    expect(operation?.nextBillingTime).toBe('2026-12-22T10:00:00.000Z');
  });

  it('records a completed sale as the last payment and calls the hook after persisting', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store);
    const seenInHook: Array<unknown> = [];
    const hook: SubscriptionEffectsHook = async (operationId, effects, context) => {
      const stored = await store.findOperationById(operationId);
      seenInHook.push({
        lastPayment: readSubscriptionOperationState(stored as PaymentOperation).lastPayment,
        effects,
        evidenceId: context.evidenceId,
        source: context.source,
      });
    };
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    const receipt = await receive(service, saleBody('WH-S1', 'SALE-1', '9.99'));

    expect(receipt.processingStatus).toBe('processed');
    const lastPayment = {
      amountMinor: '999',
      currency: 'USD',
      time: '2026-10-22T10:00:00.000Z',
    };
    expect(
      readSubscriptionOperationState((await store.findOperationById(seeded.operationId))!)
        .lastPayment,
    ).toEqual(lastPayment);
    expect(seenInHook).toEqual([
      {
        lastPayment,
        effects: [
          {
            type: 'payment_completed',
            amountMinor: '999',
            currency: 'USD',
            saleId: 'SALE-1',
            time: '2026-10-22T10:00:00.000Z',
          },
        ],
        evidenceId: receipt.evidenceId,
        source: 'webhook',
      },
    ]);
  });

  it('reports a sale in another currency than the stored plan price and does not record it', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store);
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    const receipt = await receive(service, saleBody('WH-JPY', 'SALE-JPY', '1', 'JPY'));

    expect(receipt.processingStatus).toBe('processed');
    const stored = await store.findOperationById(seeded.operationId);
    expect(readSubscriptionOperationState(stored!).lastPayment).toBeNull();
    expect(calls.map((call) => call.effects)).toEqual([
      [
        {
          type: 'currency_mismatch',
          expectedCurrency: 'USD',
          actualCurrency: 'JPY',
          saleId: 'SALE-JPY',
        },
      ],
    ]);
  });

  it('reports a sale below the stored plan price as amount_mismatch', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store);
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    await receive(service, saleBody('WH-LOW', 'SALE-LOW', '0.01'));

    const stored = await store.findOperationById(seeded.operationId);
    expect(readSubscriptionOperationState(stored!).lastPayment).toBeNull();
    expect(calls[0]?.effects).toEqual([
      {
        type: 'amount_mismatch',
        expected: { amountMinor: '999', currency: 'USD' },
        actual: { amountMinor: '1', currency: 'USD' },
        saleId: 'SALE-LOW',
      },
    ]);
  });

  it('counts BILLING.SUBSCRIPTION.PAYMENT.FAILED and reports payment_failed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store);
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    for (const id of ['WH-F1', 'WH-F2']) {
      const receipt = await receive(service, {
        id,
        event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
        resource: { id: 'I-1' },
      });
      expect(receipt.processingStatus).toBe('processed');
    }

    const stored = await store.findOperationById(seeded.operationId);
    expect(readSubscriptionOperationState(stored!).failedPaymentsCount).toBe(2);
    expect(stored?.subscriptionStatus).toBe('active');
    expect(calls.map((call) => call.effects)).toEqual([
      [{ type: 'payment_failed', failedPaymentsCount: 1, outstandingBalance: null }],
      [{ type: 'payment_failed', failedPaymentsCount: 2, outstandingBalance: null }],
    ]);
  });

  it('reports a refund as refund_or_reversal', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedActiveSubscription(store);
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    const receipt = await receive(service, {
      id: 'WH-REF',
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-1',
        sale_id: 'SALE-1',
        billing_agreement_id: 'I-1',
        amount: { total: '-9.99', currency: 'USD' },
      },
    });

    expect(receipt.processingStatus).toBe('processed');
    expect(calls[0]?.effects).toEqual([
      {
        type: 'refund_or_reversal',
        eventType: 'PAYMENT.SALE.REFUNDED',
        amountMinor: '-999',
        currency: 'USD',
        saleId: 'SALE-1',
      },
    ]);
  });

  it('a completed sale redelivered under a new webhook id is not recorded twice', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedActiveSubscription(store);
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    await receive(service, saleBody('WH-D1', 'SALE-D', '9.99'));
    const second = await receive(service, saleBody('WH-D2', 'SALE-D', '9.99'));

    expect(second.processingStatus).toBe('processed');
    expect(calls).toHaveLength(1);
  });

  it('detects a plan mismatch from the event body without a provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const plan = await seedPlan(store);
    sequence += 1;
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: `sub-${sequence}`,
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: 'fp-sub',
      kind: 'subscription',
      parentOperationId: plan.operationId,
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-1',
      providerPlanId: plan.providerPlanId,
    });
    const seeded = await store.transitionOperation({
      operationId: created.operationId,
      expectedVersion: created.version,
      nextStatus: 'submitted',
      reason: 'seed',
    });
    const { calls, hook } = recordingHook();
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    const receipt = await receive(service, {
      id: 'WH-PLAN',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-1', plan_id: 'P-OTHER', status: 'ACTIVE' },
    });

    expect(receipt.processingStatus).toBe('pending');
    const evidence = await store.findEvidenceById(receipt.evidenceId);
    expect(evidence?.errorCode).toBe(PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH);
    const after = await store.findOperationById(seeded.operationId);
    expect(after?.subscriptionStatus).toBe('approval_pending');
    expect(after?.providerPlanId).toBe(plan.providerPlanId);
    expect(calls[0]?.effects).toEqual([
      { type: 'plan_mismatch', expectedPlanId: plan.providerPlanId, actualPlanId: 'P-OTHER' },
    ]);
  });

  it('keeps the evidence retryable when the hook throws and delivers the effects on reprocessing', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store);
    const hook = vi
      .fn<SubscriptionEffectsHook>()
      .mockRejectedValueOnce(new Error('host database is down'))
      .mockResolvedValue(undefined);
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );

    const receipt = await receive(service, saleBody('WH-H', 'SALE-H', '9.99'));

    expect(receipt.processingStatus).toBe('pending');
    const failed = await store.findEvidenceById(receipt.evidenceId);
    expect(failed?.errorCode).toBe(SUBSCRIPTION_EFFECTS_HOOK_FAILED);
    expect(failed?.errorMessage ?? '').not.toContain('host database');
    expect(
      readSubscriptionOperationState((await store.findOperationById(seeded.operationId))!)
        .lastPayment?.amountMinor,
    ).toBe('999');

    const retried = await service.reprocessStoredWebhookEvidence(receipt.evidenceId);

    expect(retried.processingStatus).toBe('processed');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[1]?.[1]).toEqual(hook.mock.calls[0]?.[1]);
    expect(hook.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ type: 'payment_completed', saleId: 'SALE-H' }),
    ]);
    const evidence = await store.findEvidenceById(receipt.evidenceId);
    expect(evidence?.errorCode).toBeNull();

    // Once delivered, the effects are not delivered again.
    await service.reprocessStoredWebhookEvidence(receipt.evidenceId);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('createBillingPlan stores the lowest paid cycle price as the expected payment', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = {
      createProduct: async () => ({ providerProductId: 'PROD-1', productStatus: 'created' }),
      createPlan: async () => ({
        providerPlanId: 'P-PRICED',
        providerProductId: 'PROD-1',
        planStatus: 'active',
      }),
    } as unknown as SubscriptionProviderPort;
    const service = new SubscriptionLifecycleService(store, provider);
    const product = await service.createCatalogProduct({
      ...ctx,
      idempotencyKey: 'prod-priced',
      name: 'Premium',
      type: 'SERVICE',
    });

    const plan = await service.createBillingPlan({
      ...ctx,
      idempotencyKey: 'plan-priced',
      productOperationId: product.productOperationId,
      name: 'Monthly',
      billingCycles: [
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 1,
          price: { currency: 'USD', amountMinor: '0' },
        },
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 0,
          price: { currency: 'USD', amountMinor: '999' },
        },
      ],
      paymentPreferences: {},
    });

    const stored = await store.findOperationById(plan.planOperationId);
    expect(stored?.amountMinor).toBe('999');
    expect(stored?.currencyCode).toBe('USD');
  });
});
