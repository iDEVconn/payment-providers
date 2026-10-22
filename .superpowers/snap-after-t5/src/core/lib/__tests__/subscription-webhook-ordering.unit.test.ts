import { describe, expect, it, vi } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { ReconciliationService } from '../reconciliation-service';
import { applySubscriptionTransition } from '../subscription-evidence-application';
import {
  formatSubscriptionProviderStateWatermark,
  readSubscriptionProviderStateWatermark,
} from '../subscription-transition-policy';

const T_NEW = '2026-06-02T12:00:00.000Z';
const T_OLD = '2026-06-01T12:00:00.000Z';
const T_SAME = '2026-06-02T12:00:00.000Z';

async function seedActiveSubscription(
  store: MemoryPaymentReliabilityStore,
  idempotencyKey: string,
) {
  const scope = buildOperationIdempotencyScope({
    applicationRef: 'test-app',
    accountRef: 'default',
    environment: 'sandbox',
    kind: 'subscription',
  });
  const operation = await store.createOperation({
    idempotencyKey,
    idempotencyScope: scope,
    commandFingerprint: 'fp-ordering',
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox',
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: 'SUB-ORDER-1',
    providerReferenceId: 'SUB-ORDER-1',
  });
  return store.transitionOperation({
    operationId: operation.operationId,
    expectedVersion: operation.version,
    nextStatus: 'succeeded',
    subscriptionStatus: 'active',
    reason: 'seed active',
  });
}

function webhookPayload(eventType: string, updateTime: string) {
  return JSON.stringify({
    event_type: eventType,
    resource: {
      id: 'SUB-ORDER-1',
      update_time: updateTime,
      create_time: '2020-01-01T00:00:00Z',
    },
  });
}

describe('subscription webhook provider-state ordering', () => {
  it('keeps active when a newer ACTIVATED is followed by an older SUSPENDED', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-active-first');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_NEW,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_NEW);

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: T_OLD,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_NEW);
  });

  it('keeps suspended when a newer SUSPENDED is followed by an older ACTIVATED', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-suspended-first');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: T_NEW,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('suspended');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_OLD,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(operation.subscriptionStatus).toBe('suspended');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_NEW);
  });

  it('advances the watermark on a newer same-status ACTIVATED event', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-watermark');

    const tFirst = '2026-06-01T10:00:00.000Z';
    const tSecond = '2026-06-03T10:00:00.000Z';

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: tFirst,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(tFirst);

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: tSecond,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(tSecond);
    expect(operation.providerSubscriptionStateAt).toBe(tSecond);
    expect(operation.providerTransactionId).toBeNull();
  });

  it('persists the watermark so reload sees the same provider-state time', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedActiveSubscription(store, 'sub-order-reload');

    await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_NEW,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });

    const reloaded = await store.findOperationById(operation.operationId);
    expect(reloaded?.providerSubscriptionStateAt).toBe(T_NEW);
    expect(readSubscriptionProviderStateWatermark(reloaded!)).toBe(T_NEW);
  });

  it('keeps a genuine providerTransactionId when the watermark is updated', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store, 'sub-order-txn-id');
    const operation = await store.updateOperation({
      operationId: seeded.operationId,
      expectedVersion: seeded.version,
      providerTransactionId: 'TXN-SALE-42',
    });

    const updated = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_NEW,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });

    expect(updated.providerTransactionId).toBe('TXN-SALE-42');
    expect(updated.providerSubscriptionStateAt).toBe(T_NEW);
  });

  it('honors a legacy prefixed providerTransactionId watermark until a replacement is persisted', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store, 'sub-order-legacy-prefix');
    let operation = await store.updateOperation({
      operationId: seeded.operationId,
      expectedVersion: seeded.version,
      providerTransactionId: formatSubscriptionProviderStateWatermark(T_NEW),
    });
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_NEW);

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: T_OLD,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(operation.providerTransactionId).toBe(formatSubscriptionProviderStateWatermark(T_NEW));

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: '2026-06-04T12:00:00.000Z',
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(operation.providerSubscriptionStateAt).toBe('2026-06-04T12:00:00.000Z');
    expect(operation.providerTransactionId).toBeNull();
  });

  it('reloads and reevaluates ordering after an optimistic version conflict', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-version-conflict');
    const t1 = '2026-06-01T12:00:00.000Z';
    const t2 = '2026-06-03T12:00:00.000Z';
    const tStale = '2026-06-01T10:00:00.000Z';

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: t1,
      applySource: 'webhook',
      reason: 'first watermark',
    });
    const staleSnapshot = { ...operation, version: operation.version - 1 };

    await store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      lifecycleReason: 'concurrent writer',
    });

    const updated = await applySubscriptionTransition(store, {
      operation: staleSnapshot,
      subscriptionStatus: 'active',
      providerStateTimestamp: t2,
      applySource: 'webhook',
      reason: 'newer webhook after conflict',
    });
    expect(updated.providerSubscriptionStateAt).toBe(t2);

    const noop = await applySubscriptionTransition(store, {
      operation: staleSnapshot,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: tStale,
      applySource: 'webhook',
      reason: 'older webhook after newer watermark',
    });
    expect(noop.subscriptionStatus).toBe('active');
    const reloaded = await store.findOperationById(operation.operationId);
    expect(reloaded?.providerSubscriptionStateAt).toBe(t2);
  });

  it('does not apply conflicting state when timestamps are equal', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-equal-ts');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_SAME,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: T_SAME,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_SAME);
  });

  it('ignores events without a timestamp when a watermark is already established', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedActiveSubscription(store, 'sub-order-missing-ts');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      providerStateTimestamp: T_NEW,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.ACTIVATED',
    });

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      providerStateTimestamp: null,
      applySource: 'webhook',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED without resource time',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(operation)).toBe(T_NEW);
  });

  it('does not regress state when stale unmatched evidence is replayed through reconciliation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const seeded = await seedActiveSubscription(store, 'sub-order-reconcile-stale');
    const operation = await store.updateOperation({
      operationId: seeded.operationId,
      expectedVersion: seeded.version,
      providerTransactionId: formatSubscriptionProviderStateWatermark(T_NEW),
    });

    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-stale-suspended',
      rawPayload: webhookPayload('BILLING.SUBSCRIPTION.SUSPENDED', T_OLD),
      payloadSha256: 'sha-stale-suspended',
      eventType: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resourceId: 'SUB-ORDER-1',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'unmatched',
      relatedOperationId: operation.operationId,
    });

    const getSubscription = vi.fn().mockResolvedValue({
      providerSubscriptionId: 'SUB-ORDER-1',
      providerPlanId: 'PLAN-1',
      subscriptionStatus: 'unknown',
      approvalUrl: null,
      startTime: null,
      nextBillingTime: null,
    });

    const service = new ReconciliationService(store, {
      getOrder: async () => ({
        providerOrderId: 'order-1',
        checkoutStatus: 'unknown',
        approvalUrl: null,
        amount: null,
        providerCaptureId: null,
      }),
      getRefund: async () => ({
        providerRefundId: 'refund-1',
        refundStatus: 'unknown',
        amount: null,
      }),
      getPayoutBatch: async () => ({
        providerPayoutBatchId: 'batch-1',
        senderBatchId: 'sender-1',
        batchPayoutStatus: 'unknown',
        items: [],
      }),
      getPayoutItem: async () => ({
        providerPayoutItemId: 'item-1',
        providerPayoutBatchId: 'batch-1',
        senderBatchId: 'sender-1',
        senderItemId: 'sender-item-1',
        payoutStatus: 'unknown',
        amount: null,
        providerTransactionId: null,
        providerFee: null,
        failureCode: null,
        failureMessage: null,
      }),
      getProduct: async () => ({
        providerProductId: 'PROD-1',
        productStatus: 'created',
      }),
      getPlan: async () => ({
        providerPlanId: 'PLAN-1',
        providerProductId: 'PROD-1',
        planStatus: 'active',
      }),
      getSubscription,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    const updated = await store.findOperationById(operation.operationId);
    expect(updated?.subscriptionStatus).toBe('active');
    expect(readSubscriptionProviderStateWatermark(updated!)).toBe(T_NEW);
  });
});
