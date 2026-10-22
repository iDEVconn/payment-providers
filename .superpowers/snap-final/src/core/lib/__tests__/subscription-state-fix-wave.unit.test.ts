import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  type PaymentOperation,
  type ExecuteGetSubscriptionResult,
} from '../../../contracts/index';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { ReconciliationService } from '../reconciliation-service';
import {
  HELD_EFFECTS_OVERFLOW,
  SUBSCRIPTION_EFFECTS_HOOK_MISSING,
  adoptSubscriptionPlan,
  readSubscriptionOperationState,
  type SubscriptionEffectsHook,
} from '../subscription-evidence-application';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { WebhookProcessingService } from '../webhook-processing-service';

/* T6a review fix wave: probes p-revise, p-jsonb, p-cap2 and the lifecycle command path. */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

let sequence = 0;

async function seed(
  store: MemoryPaymentReliabilityStore,
  options: { status?: 'active' | 'approval_pending'; watermark?: string } = {},
): Promise<PaymentOperation> {
  sequence += 1;
  const plan = await store.createOperation({
    ...ctx,
    idempotencyKey: `plan-${sequence}`,
    idempotencyScope: 'plan',
    commandFingerprint: 'fp',
    kind: 'billing_plan',
    planStatus: 'active',
    providerPlanId: 'P-1',
    amountMinor: '1000',
    currencyCode: 'USD',
  });
  const created = await store.createOperation({
    ...ctx,
    idempotencyKey: `sub-${sequence}`,
    idempotencyScope: 'sub',
    commandFingerprint: 'fp',
    kind: 'subscription',
    parentOperationId: plan.operationId,
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: 'I-1',
    providerReferenceId: 'I-1',
    providerPlanId: 'P-1',
    providerSubscriptionStateAt: options.watermark ?? null,
  });
  if (options.status === 'approval_pending') {
    return created;
  }
  return store.transitionOperation({
    operationId: created.operationId,
    expectedVersion: created.version,
    nextStatus: 'succeeded',
    subscriptionStatus: 'active',
    reason: 'seed',
  });
}

function receive(service: WebhookProcessingService, body: Record<string, unknown>) {
  return service.receiveWebhook({
    ...ctx,
    rawBody: JSON.stringify(body),
    verify: async () => ({
      verified: true,
      transmissionId: String(body.id),
      eventType: String(body.event_type),
      resourceId: 'I-1',
    }),
  });
}

const sale = (id: string, saleId: string, total: string, t = '2026-10-22T10:00:00Z') => ({
  id,
  event_type: 'PAYMENT.SALE.COMPLETED',
  create_time: t,
  resource: {
    id: saleId,
    billing_agreement_id: 'I-1',
    amount: { total, currency: 'USD' },
    update_time: t,
  },
});

const subEvent = (id: string, type: string, status: string, planId: string, t: string) => ({
  id,
  event_type: type,
  create_time: t,
  resource: {
    id: 'I-1',
    status,
    plan_id: planId,
    update_time: t,
    billing_info: { next_billing_time: '2026-12-01T00:00:00Z', failed_payments_count: 0 },
  },
});

const find = (store: MemoryPaymentReliabilityStore) =>
  store.findOperationByProviderSubscriptionId('paypal', 'default', 'sandbox', 'I-1');

function snapshot(over: Partial<ExecuteGetSubscriptionResult> = {}): ExecuteGetSubscriptionResult {
  return {
    providerSubscriptionId: 'I-1',
    providerPlanId: 'P-1',
    subscriptionStatus: 'cancelled',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: 'x',
    ...over,
  };
}

describe('lifecycle commands run through the reducer (review finding 1)', () => {
  function lifecycle(
    store: MemoryPaymentReliabilityStore,
    cancelled: ExecuteGetSubscriptionResult,
    hook?: SubscriptionEffectsHook,
  ) {
    const provider = {
      cancelSubscription: async () => cancelled,
    } as unknown as SubscriptionProviderPort;
    return new SubscriptionLifecycleService(store, provider, { onSubscriptionEffects: hook });
  }

  it('applies a cancellation on another plan, keeps a newer watermark and stores billing data', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seed(store, { watermark: '2026-10-25T00:00:00.000Z' });
    const hook = vi.fn<SubscriptionEffectsHook>();
    const service = lifecycle(
      store,
      snapshot({
        providerPlanId: 'P-OTHER',
        providerSubscriptionStateAt: '2026-10-20T00:00:00.000Z',
        lastPayment: { amountMinor: '1000', currency: 'USD', time: '2026-10-01T00:00:00.000Z' },
        failedPaymentsCount: 1,
      }),
      hook,
    );

    const result = await service.cancelSubscription({
      ...ctx,
      idempotencyKey: 'c1',
      subscriptionOperationId: seeded.operationId,
      reason: 'user',
    });

    expect(result.subscriptionStatus).toBe('cancelled');
    const after = await store.findOperationById(seeded.operationId);
    expect(after?.subscriptionStatus).toBe('cancelled');
    expect(after?.providerPlanId).toBe('P-1');
    expect(after?.providerSubscriptionStateAt).toBe('2026-10-25T00:00:00.000Z');
    expect(after?.lifecycleReason).toBe('x');
    const state = readSubscriptionOperationState(after!);
    expect(state.failedPaymentsCount).toBe(1);
    expect(state.lastPayment?.amountMinor).toBe('1000');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        { type: 'plan_mismatch', expectedPlanId: 'P-1', actualPlanId: 'P-OTHER' },
        { type: 'status_changed', from: 'active', to: 'cancelled' },
      ]),
    );
  });

  it('a failing hook makes the command throw and a replay of the same key delivers again', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seed(store);
    const hook = vi
      .fn<SubscriptionEffectsHook>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);
    const service = lifecycle(store, snapshot(), hook);
    const request = {
      ...ctx,
      idempotencyKey: 'c-hook',
      subscriptionOperationId: seeded.operationId,
      reason: 'user',
    };

    await expect(service.cancelSubscription(request)).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_EFFECTS_HOOK_FAILED,
    });
    expect((await store.findOperationById(seeded.operationId))?.subscriptionStatus).toBe(
      'cancelled',
    );

    await service.cancelSubscription(request);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[1]?.[1]).toEqual(hook.mock.calls[0]?.[1]);
    await service.cancelSubscription(request);
    expect(hook).toHaveBeenCalledTimes(2);
  });
});

describe('plan revision (review finding 2, probe p-revise)', () => {
  it('reports plan_mismatch once per row and lets the host adopt the new plan and price', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seed(store);
    const calls: string[][] = [];
    const hook: SubscriptionEffectsHook = (_operationId, effects) => {
      calls.push(effects.map((effect) => effect.type));
    };
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: service,
      consumer: null,
    });

    const updated = await receive(
      service,
      subEvent('WH-UPD', 'BILLING.SUBSCRIPTION.UPDATED', 'ACTIVE', 'P-2', '2026-11-01T00:00:00Z'),
    );
    expect(updated.processingStatus).toBe('pending');
    for (let run = 0; run < 3; run += 1) {
      await recovery.recover({ workerId: 'w', limit: 10 });
    }
    expect(calls).toEqual([['plan_mismatch']]);

    const adopted = await adoptSubscriptionPlan({
      store,
      operationId: seeded.operationId,
      providerPlanId: 'P-2',
      amountMinor: '500',
      currencyCode: 'USD',
      webhookProcessing: service,
    });

    expect(adopted.reprocessed.map((receipt) => receipt.evidenceId)).toEqual([updated.evidenceId]);
    expect((await store.findEvidenceById(updated.evidenceId))?.processingStatus).toBe('processed');
    const after = await find(store);
    expect(after?.providerPlanId).toBe('P-2');
    expect(after?.amountMinor).toBe('500');
    expect(after?.nextBillingTime).toBe('2026-12-01T00:00:00.000Z');

    const renewal = await receive(service, sale('WH-S1', 'SALE-1', '5.00', '2026-11-01T00:05:00Z'));
    expect(renewal.processingStatus).toBe('processed');
    expect(readSubscriptionOperationState((await find(store))!).lastPayment?.amountMinor).toBe(
      '500',
    );
  });
});

describe('subscriptionStateJson as text or jsonb (review findings 3 and 6, probe p-jsonb)', () => {
  /** A jsonb column read through a pg driver: the field comes back as an object. */
  function jsonbStore(): MemoryPaymentReliabilityStore {
    const inner = new MemoryPaymentReliabilityStore();
    const toObject = (value: unknown): unknown => {
      if (!value || typeof value !== 'object' || !('subscriptionStateJson' in value)) {
        return value;
      }
      const row = value as PaymentOperation;
      return typeof row.subscriptionStateJson === 'string'
        ? { ...row, subscriptionStateJson: JSON.parse(row.subscriptionStateJson) }
        : row;
    };
    return new Proxy(inner, {
      get(target, key) {
        const member = Reflect.get(target, key) as unknown;
        return typeof member === 'function'
          ? async (...args: unknown[]) =>
              toObject(await (member as (...a: unknown[]) => unknown).apply(target, args))
          : member;
      },
    });
  }

  const failed = (id: string, t: string) => ({
    id,
    event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    create_time: t,
    resource: { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', update_time: t },
  });

  it('keeps the state when the store returns the column as an object', async () => {
    const store = jsonbStore();
    await seed(store);
    const service = new WebhookProcessingService(store);

    await receive(service, failed('WH-F1', '2026-10-22T10:00:00Z'));
    await receive(service, failed('WH-F2', '2026-10-22T11:00:00Z'));
    await receive(service, sale('WH-S', 'SALE-1', '10.00'));

    const state = readSubscriptionOperationState((await find(store))!);
    expect(state.failedPaymentsCount).toBe(2);
    expect(state.lastPayment?.amountMinor).toBe('1000');
  });

  async function seedWithState(json: string) {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seed(store);
    const withState = await store.updateOperation({
      operationId: seeded.operationId,
      expectedVersion: seeded.version,
      subscriptionStateJson: json,
    });
    return { store, operation: withState };
  }

  it.each([
    ['corrupt text', '{not json', PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_UNREADABLE],
    [
      'a wrong field type',
      JSON.stringify({ version: 1, failedPaymentsCount: 'two' }),
      PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_UNREADABLE,
    ],
    [
      'a newer version',
      JSON.stringify({ version: 2, failedPaymentsCount: 3 }),
      PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_VERSION_UNSUPPORTED,
    ],
  ])(
    'fails closed on %s: evidence stays pending and the state is not rewritten',
    async (_label, json, code) => {
      const { store, operation } = await seedWithState(json);
      expect(() => readSubscriptionOperationState(operation)).toThrow(
        expect.objectContaining({ code }),
      );
      const service = new WebhookProcessingService(store);

      const receipt = await receive(service, failed('WH-F1', '2026-10-22T10:00:00Z'));

      expect(receipt.processingStatus).toBe('pending');
      expect((await store.findEvidenceById(receipt.evidenceId))?.errorCode).toBe(code);
      const after = await store.findOperationById(operation.operationId);
      expect(after?.subscriptionStateJson).toBe(json);
      expect(after?.version).toBe(operation.version);
    },
  );

  it('keeps unknown fields of the same version when it rewrites the state', async () => {
    const { store } = await seedWithState(
      JSON.stringify({ version: 1, failedPaymentsCount: 0, hostNote: { keep: true } }),
    );
    const service = new WebhookProcessingService(store);

    await receive(service, failed('WH-F1', '2026-10-22T10:00:00Z'));

    const stored = JSON.parse(String((await find(store))?.subscriptionStateJson));
    expect(stored.failedPaymentsCount).toBe(1);
    expect(stored.hostNote).toEqual({ keep: true });
  });
});

describe('held effects are never dropped (review finding 4, probe p-cap2)', () => {
  it('delivers the held access grant after an outage longer than the hold limit', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seed(store, { status: 'approval_pending' });
    let failing = true;
    const delivered: string[][] = [];
    const hook: SubscriptionEffectsHook = (_operationId, effects) => {
      if (failing) {
        throw new Error('down');
      }
      delivered.push(effects.map((effect) => effect.type));
    };
    const service = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );
    const activated = subEvent(
      'WH-ACT',
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'ACTIVE',
      'P-1',
      '2026-10-22T09:00:00Z',
    );

    await receive(service, activated);
    const receipts = [];
    for (let i = 1; i <= 16; i += 1) {
      const t = `2026-10-22T10:${String(i).padStart(2, '0')}:00Z`;
      receipts.push(await receive(service, sale(`WH-${i}`, `SALE-${i}`, '10.00', t)));
    }
    const overflow = receipts.at(-1)!;
    expect(overflow.processingStatus).toBe('pending');
    expect((await store.findEvidenceById(overflow.evidenceId))?.errorCode).toBe(
      HELD_EFFECTS_OVERFLOW,
    );

    failing = false;
    const redelivered = await receive(service, activated);

    expect(redelivered.processingStatus).toBe('processed');
    expect(delivered[0]).toEqual(['status_changed', 'period_updated']);
    await new PaymentRecoveryService({ store, webhookProcessing: service, consumer: null }).recover(
      { workerId: 'w', limit: 50 },
    );
    expect(delivered).toHaveLength(17);
    expect((await store.findEvidenceById(overflow.evidenceId))?.processingStatus).toBe('processed');
  });

  it('a held reconciliation row is not marked processed by a webhook service without a hook', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: 'sub-held-nohook',
      idempotencyScope: 'sub',
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-1',
      providerPlanId: 'P-1',
    });
    await store.transitionOperation({
      operationId: created.operationId,
      expectedVersion: created.version,
      nextStatus: 'unknown',
      reason: 'seed',
    });
    const failingHook = vi.fn<SubscriptionEffectsHook>().mockRejectedValue(new Error('down'));
    await new ReconciliationService(
      store,
      {
        getSubscription: async () => snapshot({ subscriptionStatus: 'active' }),
      } as unknown as ReconciliationProviderLookup,
      { onSubscriptionEffects: failingHook },
    ).reconcile(10);
    const evidenceId = failingHook.mock.calls[0]![2].evidenceId!;

    await new PaymentRecoveryService({
      store,
      webhookProcessing: new WebhookProcessingService(store),
      consumer: null,
    }).recover({ workerId: 'w' });

    const evidence = await store.findEvidenceById(evidenceId);
    expect(evidence?.processingStatus).toBe('pending');
    expect(evidence?.errorCode).toBe(SUBSCRIPTION_EFFECTS_HOOK_MISSING);
  });
});
