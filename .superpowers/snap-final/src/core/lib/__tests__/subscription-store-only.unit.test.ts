import { describe, expect, it, vi } from 'vitest';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import type { SubscriptionStore } from '../persistence/payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { ReconciliationService } from '../reconciliation-service';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { WebhookProcessingService } from '../webhook-processing-service';

/*
 * Issue #6: a subscriptions-only host implements `SubscriptionStore` and nothing else. The four
 * services a subscription host wires must run against such a store: no checkout, payout, seller
 * or marketplace method may be called (or even exist).
 */

// Listed here by hand (not imported) so the test pins the composite independently of the source.
const SUBSCRIPTION_STORE_METHODS = [
  'createOperation',
  'findOperationById',
  'findOperationByIdempotency',
  'findOperationByProviderReference',
  'claimOperationForExecution',
  'updateOperation',
  'transitionOperation',
  'listOperationTransitions',
  'acquireCheckoutCreateExecutionLease',
  'findOperationByProviderProductId',
  'findOperationByProviderPlanId',
  'findOperationByProviderSubscriptionId',
  'insertEvidence',
  'findEvidenceById',
  'findEvidenceByProviderEvent',
  'updateEvidence',
  'claimPendingEvidence',
  'listReconciliationCandidates',
  'listUncertainOperations',
  'insertReconciliationAttempt',
] as const;

const NON_SUBSCRIPTION_METHODS = [
  'findOperationByProviderOrderId',
  'findOperationByProviderCaptureId',
  'findOperationByProviderRefundId',
  'reserveRefundCapacity',
  'findOperationBySenderBatchId',
  'findOperationBySenderItemId',
  'findOperationByProviderPayoutBatchId',
  'findOperationByProviderPayoutItemId',
  'listOperationsByParent',
  'findOperationByProviderReferralId',
  'createSellerConnection',
  'findSellerConnectionByMerchantId',
  'findSellerConnectionByTrackingId',
  'listSellerConnectionsForReconciliation',
  'updateSellerConnection',
  'insertMarketplacePurchaseUnits',
  'findMarketplacePurchaseUnitByCaptureId',
  'listMarketplacePurchaseUnits',
  'updateMarketplacePurchaseUnit',
  'findLatestReconciliationEvidenceForResource',
  'listProviderEvidenceForRecovery',
] as const;

function subscriptionOnlyStore(): {
  store: SubscriptionStore;
  calls: string[];
} {
  const backing = new MemoryPaymentReliabilityStore();
  const calls: string[] = [];
  const store: Record<string, unknown> = {};
  for (const method of SUBSCRIPTION_STORE_METHODS) {
    const fn = (backing[method] as (...args: unknown[]) => unknown).bind(backing);
    store[method] = (...args: unknown[]) => {
      calls.push(method);
      return fn(...args);
    };
  }
  return { store: store as unknown as SubscriptionStore, calls };
}

const scope = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

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

function lookup(): ReconciliationProviderLookup {
  const unexpected = () => Promise.reject(new Error('not a subscription lookup'));
  return {
    getOrder: unexpected,
    getRefund: unexpected,
    getPayoutBatch: unexpected,
    getPayoutItem: unexpected,
    getProduct: unexpected,
    getPlan: unexpected,
    getReferral: unexpected,
    getMarketplaceOrder: unexpected,
    getSubscription: vi.fn().mockResolvedValue({
      providerSubscriptionId: 'SUB-1',
      providerPlanId: 'PLAN-1',
      subscriptionStatus: 'active',
      startTime: null,
      nextBillingTime: null,
    }),
  } as unknown as ReconciliationProviderLookup;
}

function webhookBody(eventType: string, resourceId: string, id: string): string {
  return JSON.stringify({
    id,
    event_type: eventType,
    resource: { id: resourceId },
  });
}

const verified = (eventType: string, resourceId: string) => async () => ({
  verified: true,
  transmissionId: 't',
  eventType,
  resourceId,
});

async function createSubscription(store: SubscriptionStore) {
  const lifecycle = new SubscriptionLifecycleService(store, fakeProvider());
  return lifecycle.createSubscription({
    ...scope,
    idempotencyKey: 'sub-only-1',
    providerPlanId: 'PLAN-1',
    offeringRef: 'pro',
    subscriber: { subscriberRef: 'user-1' },
  });
}

describe('services with a store that implements only SubscriptionStore', () => {
  it('the test store has no checkout, payout, seller or marketplace method', () => {
    const { store } = subscriptionOnlyStore();
    for (const method of NON_SUBSCRIPTION_METHODS) {
      expect(method in store, method).toBe(false);
    }
  });

  it('SubscriptionLifecycleService creates a subscription', async () => {
    const { store } = subscriptionOnlyStore();
    const created = await createSubscription(store);
    expect(created.operationStatus).toBe('submitted');
    expect(created.providerSubscriptionId).toBe('SUB-1');
  });

  it('WebhookProcessingService applies subscription events and marks other families unsupported', async () => {
    const { store } = subscriptionOnlyStore();
    await createSubscription(store);
    const webhooks = new WebhookProcessingService(store);

    const activated = await webhooks.receiveWebhook({
      ...scope,
      rawBody: webhookBody('BILLING.SUBSCRIPTION.ACTIVATED', 'SUB-1', 'WH-ACT'),
      verify: verified('BILLING.SUBSCRIPTION.ACTIVATED', 'SUB-1'),
    });
    expect(activated.processingStatus).toBe('processed');
    const operation = await store.findOperationByProviderSubscriptionId(
      scope.providerCode,
      scope.accountRef,
      scope.environment,
      'SUB-1',
    );
    expect(operation?.subscriptionStatus).toBe('active');

    for (const [eventType, id] of [
      ['PAYMENT.CAPTURE.COMPLETED', 'WH-CAP'],
      ['CHECKOUT.ORDER.APPROVED', 'WH-ORD'],
      ['PAYMENT.PAYOUTSBATCH.SUCCESS', 'WH-PAYOUT'],
      ['MERCHANT.ONBOARDING.COMPLETED', 'WH-SELLER'],
    ] as const) {
      const receipt = await webhooks.receiveWebhook({
        ...scope,
        rawBody: webhookBody(eventType, 'RES-1', id),
        verify: verified(eventType, 'RES-1'),
      });
      expect(receipt.processingStatus, eventType).toBe('unsupported');
    }

    const payouts = await webhooks.reprocessVerifiedUnmatchedPayoutEvidence({
      limit: 10,
    });
    expect(payouts).toEqual({ processed: 0, skipped: 0, unmatched: 0 });
  });

  it('ReconciliationService reconciles an uncertain subscription without seller connections', async () => {
    const { store, calls } = subscriptionOnlyStore();
    const scopeKey = buildOperationIdempotencyScope({
      ...scope,
      kind: 'subscription',
    });
    const operation = await store.createOperation({
      ...scope,
      idempotencyKey: 'sub-uncertain',
      idempotencyScope: scopeKey,
      commandFingerprint: 'fp',
      kind: 'subscription',
      providerPlanId: 'PLAN-1',
      providerSubscriptionId: 'SUB-1',
      subscriptionStatus: 'approval_pending',
    });
    const claimed = await store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });
    await store.transitionOperation({
      operationId: claimed.operationId,
      expectedVersion: claimed.version,
      nextStatus: 'unknown',
      reason: 'timeout',
    });

    const result = await new ReconciliationService(store, lookup()).reconcile(10);
    expect(result.applied).toBe(1);
    const after = await store.findOperationById(operation.operationId);
    expect(after?.subscriptionStatus).toBe('active');
    expect(calls).not.toContain('listSellerConnectionsForReconciliation');
  });

  it('PaymentRecoveryService recovers and delivers with the subscription store', async () => {
    const { store } = subscriptionOnlyStore();
    await createSubscription(store);
    const webhooks = new WebhookProcessingService(store);
    await webhooks.receiveWebhook({
      ...scope,
      rawBody: webhookBody('BILLING.SUBSCRIPTION.ACTIVATED', 'SUB-1', 'WH-REC'),
      verify: verified('BILLING.SUBSCRIPTION.ACTIVATED', 'SUB-1'),
    });
    const deliver = vi.fn(async () => undefined);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    });
    const summary = await recovery.recover({ workerId: 'w1' });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a family with only some of its methods is a configuration error, not unsupported', async () => {
    const { store } = subscriptionOnlyStore();
    const partial = Object.assign(store, {
      findOperationByProviderOrderId: async () => null,
      listSellerConnectionsForReconciliation: async () => [],
    });
    const webhookError = (() => {
      try {
        new WebhookProcessingService(partial);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(webhookError).toBeInstanceOf(PaymentConfigurationError);
    expect((webhookError as Error).message).toMatch(/checkout/);
    expect((webhookError as PaymentConfigurationError).missingFields).toContain(
      'findOperationByProviderCaptureId',
    );
    expect(() => new ReconciliationService(partial, lookup())).toThrow(/seller/);
  });

  it('a family that becomes partial after construction fails the event instead of acking it', async () => {
    const { store } = subscriptionOnlyStore();
    const webhooks = new WebhookProcessingService(store);
    // e.g. a throw-stub or a typo added to a store object at runtime
    (store as unknown as Record<string, unknown>).findSellerConnectionByMerchantId = async () =>
      null;
    await expect(
      webhooks.receiveWebhook({
        ...scope,
        rawBody: webhookBody('MERCHANT.ONBOARDING.COMPLETED', 'M-1', 'WH-PARTIAL'),
        verify: verified('MERCHANT.ONBOARDING.COMPLETED', 'M-1'),
      }),
    ).rejects.toBeInstanceOf(PaymentConfigurationError);
    const row = await store.findEvidenceByProviderEvent(
      scope.providerCode,
      scope.accountRef,
      scope.environment,
      'WH-PARTIAL',
    );
    expect(row?.processingStatus).not.toBe('unsupported');
  });
});
