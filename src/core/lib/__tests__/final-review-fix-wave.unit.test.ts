import { describe, expect, it, vi } from 'vitest';
import type { ExecuteGetSubscriptionResult, PaymentOperation } from '../../../contracts/index';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { ReconciliationService } from '../reconciliation-service';
import {
  SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP,
  type SubscriptionEffectsHook,
} from '../subscription-evidence-application';
import { WebhookProcessingService } from '../webhook-processing-service';

/* Final whole-branch review fix wave: F3, F4, F9, F12. */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

let sequence = 0;

async function seedActive(
  store: MemoryPaymentReliabilityStore,
  watermark: string | null = null,
): Promise<PaymentOperation> {
  sequence += 1;
  const created = await store.createOperation({
    ...ctx,
    idempotencyKey: `sub-${sequence}`,
    idempotencyScope: 'sub',
    commandFingerprint: 'fp',
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: 'I-1',
    providerReferenceId: 'I-1',
    providerPlanId: 'P-1',
    providerSubscriptionStateAt: watermark,
  });
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

const cancelledAt = (id: string, t: string) => ({
  id,
  event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
  resource: { id: 'I-1', status: 'CANCELLED', plan_id: 'P-1', update_time: t },
});

function snapshot(over: Partial<ExecuteGetSubscriptionResult> = {}): ExecuteGetSubscriptionResult {
  return {
    providerSubscriptionId: 'I-1',
    providerPlanId: 'P-1',
    subscriptionStatus: 'cancelled',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: null,
    ...over,
  };
}

/** A SQL store whose nullable delivery columns read back as `null`, not `undefined` (pg mapping). */
function nullMappingStore(): MemoryPaymentReliabilityStore {
  const inner = new MemoryPaymentReliabilityStore();
  const deliveryFields = [
    'consumerDeliveryStatus',
    'consumerDeliveredAt',
    'consumerDeliveryAttempts',
    'consumerDeliveryLastError',
  ];
  const mapRow = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(mapRow);
    }
    if (!value || typeof value !== 'object' || !('providerEventId' in value)) {
      return value;
    }
    const row: Record<string, unknown> = { ...value };
    for (const field of deliveryFields) {
      row[field] ??= null;
    }
    return row;
  };
  return new Proxy(inner, {
    get(target, key) {
      const member = Reflect.get(target, key) as unknown;
      return typeof member === 'function'
        ? async (...args: unknown[]) =>
            mapRow(await (member as (...a: unknown[]) => unknown).apply(target, args))
        : member;
    },
  });
}

describe('F3: a store that returns null for the delivery columns', () => {
  it('still marks processed webhook rows pending and delivers them, but never reconciliation rows', async () => {
    const store = nullMappingStore();
    await seedActive(store);
    const webhooks = new WebhookProcessingService(store);
    const receipt = await receive(webhooks, cancelledAt('WH-NULL', '2026-10-22T10:00:00Z'));
    expect(receipt.processingStatus).toBe('processed');
    expect((await store.findEvidenceById(receipt.evidenceId))?.consumerDeliveryStatus).toBe(
      'pending',
    );

    const uncertain = await store.createOperation({
      ...ctx,
      idempotencyKey: 'sub-uncertain',
      idempotencyScope: 'sub',
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-2',
      providerPlanId: 'P-1',
    });
    await store.transitionOperation({
      operationId: uncertain.operationId,
      expectedVersion: uncertain.version,
      nextStatus: 'unknown',
      reason: 'seed',
    });
    await new ReconciliationService(store, {
      getSubscription: async () =>
        snapshot({ providerSubscriptionId: 'I-2', subscriptionStatus: 'active' }),
    } as unknown as ReconciliationProviderLookup).reconcile(10);

    const deliver = vi.fn(async () => undefined);
    const summary = await new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    }).recover({ workerId: 'w', limit: 25 });

    expect(summary.delivered).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]).toEqual([
      expect.objectContaining({ providerEventId: 'WH-NULL' }),
    ]);
  });
});

describe('F4: a conflicting status at the same provider second', () => {
  const T = '2026-10-22T10:00:00.000Z';

  it('the provider lookup wins: CANCELLED at the stored second ends cancelled', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActive(store, T);
    const getSubscription = vi.fn(async () => snapshot({ providerSubscriptionStateAt: T }));
    const webhooks = new WebhookProcessingService(store, { getSubscription });

    const receipt = await receive(webhooks, cancelledAt('WH-EQ', T));

    expect(receipt.processingStatus).toBe('processed');
    expect((await store.findOperationById(seeded.operationId))?.subscriptionStatus).toBe(
      'cancelled',
    );
  });

  it('without a lookup the row is not marked processed and reconciliation repairs it', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActive(store, T);
    const webhooks = new WebhookProcessingService(store);

    const receipt = await receive(webhooks, cancelledAt('WH-EQ2', T));

    expect(receipt.processingStatus).not.toBe('processed');
    const row = await store.findEvidenceById(receipt.evidenceId);
    expect(row?.errorCode).toBe(SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP);
    expect(row?.relatedOperationId).toBe(seeded.operationId);
    expect((await store.findOperationById(seeded.operationId))?.subscriptionStatus).toBe('active');

    const result = await new ReconciliationService(store, {
      getSubscription: async () => snapshot({ providerSubscriptionStateAt: T }),
    } as unknown as ReconciliationProviderLookup).reconcile(10);

    expect(result.applied).toBe(1);
    expect((await store.findOperationById(seeded.operationId))?.subscriptionStatus).toBe(
      'cancelled',
    );
    expect((await store.findEvidenceById(receipt.evidenceId))?.processingStatus).toBe('processed');
  });

  it('reconciliation without a usable lookup leaves the conflicting row unprocessed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedActive(store, T);
    const receipt = await receive(new WebhookProcessingService(store), cancelledAt('WH-EQ3', T));

    const result = await new ReconciliationService(store, {
      getSubscription: async () => {
        throw { code: 'PROVIDER_UNCERTAIN', retryable: true, uncertain: true };
      },
    } as unknown as ReconciliationProviderLookup).reconcile(10);

    expect(result.applied).toBe(0);
    expect(result.retryableFailures).toBe(1);
    expect((await store.findEvidenceById(receipt.evidenceId))?.processingStatus).not.toBe(
      'processed',
    );
  });
});

describe('F9: intake stores only string event types and resource ids', () => {
  it('a forged body with object/number fields is stored with null type and id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const rawBody = JSON.stringify({
      id: 'WH-FORGED',
      event_type: { $gt: '' },
      resource: { id: 12345 },
    });

    await expect(
      webhooks.receiveWebhook({
        ...ctx,
        rawBody,
        verify: async () => ({
          verified: false,
          transmissionId: 't',
          failureKind: 'verification_unavailable' as const,
          unavailableReason: 'down',
        }),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });

    const row = await store.findEvidenceByProviderEvent(
      ctx.providerCode,
      ctx.accountRef,
      ctx.environment,
      'WH-FORGED',
    );
    expect(row?.eventType).toBeNull();
    expect(row?.resourceId).toBeNull();
  });
});

describe('F12: a consumer failure after processing is a delivery failure, not a failed row', () => {
  it('counts the row as processed and the delivery as deliveryFailed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedActive(store);
    const hook = vi
      .fn<SubscriptionEffectsHook>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);
    const webhooks = new WebhookProcessingService(
      store,
      undefined,
      {},
      {
        onSubscriptionEffects: hook,
      },
    );
    const receipt = await receive(webhooks, cancelledAt('WH-F12', '2026-10-22T10:00:00Z'));
    expect(receipt.processingStatus).toBe('pending');
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: {
        deliver: async () => {
          throw new Error('consumer down');
        },
      },
    });

    const summary = await recovery.recoverEvidence({
      evidenceId: receipt.evidenceId,
      workerId: 'w',
      environment: ctx.environment,
    });

    expect(summary).toMatchObject({ processed: 1, failed: 0, deliveryFailed: 1 });
    const row = await store.findEvidenceById(receipt.evidenceId);
    expect(row?.processingStatus).toBe('processed');
    expect(row?.consumerDeliveryStatus).toBe('failed');
    expect(row?.consumerDeliveryAttempts).toBe(1);
  });
});
