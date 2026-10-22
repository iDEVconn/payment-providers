import { describe, expect, it, vi } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { ReconciliationService } from '../reconciliation-service';
import {
  applySubscriptionTransition,
  applySubscriptionDomainUpdate,
} from '../subscription-evidence-application';
import {
  assertSubscriptionTransitionAllowed,
  resolveSubscriptionStatusTransition,
} from '../subscription-transition-policy';

async function seedSubscription(
  store: MemoryPaymentReliabilityStore,
  input: {
    idempotencyKey: string;
    subscriptionStatus: 'active' | 'cancelled' | 'expired' | 'suspended' | 'approval_pending';
    providerSubscriptionId?: string;
    executionStatus?: 'succeeded' | 'failed' | 'submitted';
  },
) {
  const scope = buildOperationIdempotencyScope({
    applicationRef: 'test-app',
    accountRef: 'default',
    environment: 'sandbox',
    kind: 'subscription',
  });
  const operation = await store.createOperation({
    idempotencyKey: input.idempotencyKey,
    idempotencyScope: scope,
    commandFingerprint: 'fp-sub-regression',
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox',
    kind: 'subscription',
    subscriptionStatus: input.subscriptionStatus,
    providerSubscriptionId: input.providerSubscriptionId ?? 'SUB-REG-1',
    providerReferenceId: input.providerSubscriptionId ?? 'SUB-REG-1',
  });
  const nextStatus = input.executionStatus ?? 'succeeded';
  if (nextStatus !== 'submitted') {
    return store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus,
      reason: 'seed subscription regression',
    });
  }
  return operation;
}

describe('subscription status regression', () => {
  it('keeps active when a late CREATED webhook maps to approval_pending', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedSubscription(store, {
      idempotencyKey: 'sub-late-created',
      subscriptionStatus: 'active',
    });

    const updated = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'approval_pending',
      reason: 'Late BILLING.SUBSCRIPTION.CREATED',
    });

    expect(updated.subscriptionStatus).toBe('active');
    expect(updated.status).toBe('succeeded');
  });

  it('keeps cancelled when later SUSPENDED or ACTIVATED events arrive', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedSubscription(store, {
      idempotencyKey: 'sub-cancelled-stale',
      subscriptionStatus: 'cancelled',
      executionStatus: 'failed',
    });

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'suspended',
      reason: 'Stale BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('cancelled');

    operation = await applySubscriptionTransition(store, {
      operation,
      subscriptionStatus: 'active',
      reason: 'Stale BILLING.SUBSCRIPTION.ACTIVATED',
    });
    expect(operation.subscriptionStatus).toBe('cancelled');
  });

  it('does not allow expired subscriptions to reactivate', () => {
    expect(() => assertSubscriptionTransitionAllowed('expired', 'active')).toThrow();
    expect(resolveSubscriptionStatusTransition('expired', 'active')).toBe('expired');
  });

  it('prefers provider ACTIVE over stale CREATED during reconciliation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedSubscription(store, {
      idempotencyKey: 'sub-reconcile-created',
      subscriptionStatus: 'active',
    });
    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-created-replay',
      rawPayload: JSON.stringify({
        event_type: 'BILLING.SUBSCRIPTION.CREATED',
        resource: { id: 'SUB-REG-1' },
      }),
      payloadSha256: 'sha-created-replay',
      eventType: 'BILLING.SUBSCRIPTION.CREATED',
      resourceId: 'SUB-REG-1',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'unmatched',
      relatedOperationId: operation.operationId,
    });

    const getSubscription = vi.fn().mockResolvedValue({
      providerSubscriptionId: 'SUB-REG-1',
      providerPlanId: 'PLAN-1',
      subscriptionStatus: 'active',
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
  });

  it('still allows active to suspend and reactivate', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await seedSubscription(store, {
      idempotencyKey: 'sub-suspend-cycle',
      subscriptionStatus: 'active',
    });

    operation = await applySubscriptionDomainUpdate(store, operation, {
      subscriptionStatus: 'suspended',
      reason: 'BILLING.SUBSCRIPTION.SUSPENDED',
    });
    expect(operation.subscriptionStatus).toBe('suspended');

    operation = await applySubscriptionDomainUpdate(store, operation, {
      subscriptionStatus: 'active',
      reason: 'BILLING.SUBSCRIPTION.RE-ACTIVATED',
    });
    expect(operation.subscriptionStatus).toBe('active');
    expect(operation.status).toBe('succeeded');
  });
});
