import { describe, expect, it, vi } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { ReconciliationService } from '../reconciliation-service';

const subscriptionLookup = {
  getProduct: async () => ({
    providerProductId: 'PROD-1',
    productStatus: 'created' as const,
  }),
  getPlan: async () => ({
    providerPlanId: 'PLAN-1',
    providerProductId: 'PROD-1',
    planStatus: 'active' as const,
  }),
  getSubscription: async () => ({
    providerSubscriptionId: 'SUB-1',
    providerPlanId: 'PLAN-1',
    subscriptionStatus: 'active' as const,
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
  }),
};

const sellerLookup = {
  getReferral: async () => ({
    providerReferralId: 'REF-1',
    actionUrl: 'https://paypal.example/action',
  }),
  findMerchantByTrackingId: async () => ({
    providerMerchantId: null,
    trackingId: 'seller-a',
  }),
  getMerchantStatus: async () => ({
    providerMerchantId: 'MERCHANT-1',
    trackingId: 'seller-a',
    paymentsReceivable: true,
    primaryEmailConfirmed: true,
    grantedScopes: [],
    productActive: true,
    hasLimitations: false,
    consentPresent: true,
  }),
};

describe('ReconciliationService', () => {
  it('records retryable failure when provider state remains unknown', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'checkout',
    });
    const operation = await store.createOperation({
      idempotencyKey: 'idem-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'checkout',
      providerReferenceId: 'order-1',
    });
    await store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'seed',
    });
    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-1',
      rawPayload: '{}',
      payloadSha256: 'abc',
      eventType: 'UNKNOWN.EVENT',
      resourceId: 'order-1',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'unmatched',
      relatedOperationId: operation.operationId,
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
      ...subscriptionLookup,
      ...sellerLookup,
    });
    const result = await service.reconcile(10);
    expect(result.retryableFailures).toBe(1);
  });

  it('applies provider lookup for uncertain refund operations', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const captureScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    const capture = await store.createOperation({
      idempotencyKey: 'cap-1',
      idempotencyScope: captureScope,
      commandFingerprint: 'fp-cap',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'capture',
      providerCaptureId: 'capture-1',
      providerOrderId: 'order-1',
      amountMinor: '1000',
      currencyCode: 'USD',
    });
    await store.transitionOperation({
      operationId: capture.operationId,
      expectedVersion: 1,
      nextStatus: 'succeeded',
      reason: 'seed',
    });

    const refundScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'refund',
    });
    const refund = await store.createOperation({
      idempotencyKey: 'ref-1',
      idempotencyScope: refundScope,
      commandFingerprint: 'fp-ref',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'refund',
      parentOperationId: capture.operationId,
      providerRefundId: 'refund-1',
      providerCaptureId: 'capture-1',
      amountMinor: '500',
      currencyCode: 'USD',
    });
    await store.transitionOperation({
      operationId: refund.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      providerRefundId: 'refund-1',
      providerReferenceId: 'refund-1',
      reason: 'seed uncertain refund with provider id',
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
        refundStatus: 'completed',
        amount: { currency: 'USD', amountMinor: '500' },
      }),
      getPayoutBatch: async () => ({
        providerPayoutBatchId: 'batch-1',
        senderBatchId: 'sender-1',
        batchPayoutStatus: 'processing',
        items: [],
      }),
      getPayoutItem: async () => ({
        providerPayoutItemId: 'item-1',
        providerPayoutBatchId: 'batch-1',
        senderBatchId: 'sender-1',
        senderItemId: 'sender-item-1',
        payoutStatus: 'succeeded',
        amount: { currency: 'USD', amountMinor: '500' },
        providerTransactionId: 'txn-1',
        providerFee: null,
        failureCode: null,
        failureMessage: null,
      }),
      ...subscriptionLookup,
      ...sellerLookup,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    const updated = await store.findOperationById(refund.operationId);
    expect(updated?.status).toBe('succeeded');
  });

  it('applies provider lookup for uncertain payout item operations', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const batchScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'payout_batch',
    });
    const batch = await store.createOperation({
      idempotencyKey: 'batch-1',
      idempotencyScope: batchScope,
      commandFingerprint: 'fp-batch',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'batch-provider-1',
      payoutStatus: 'processing',
    });
    const itemScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'payout_item',
    });
    const item = await store.createOperation({
      idempotencyKey: 'item-1',
      idempotencyScope: itemScope,
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      providerPayoutItemId: 'item-provider-1',
      payoutStatus: 'pending',
    });
    await store.transitionOperation({
      operationId: item.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'seed uncertain payout item',
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
        providerPayoutBatchId: 'batch-provider-1',
        senderBatchId: 'sender-1',
        batchPayoutStatus: 'processing',
        items: [],
      }),
      getPayoutItem: async () => ({
        providerPayoutItemId: 'item-provider-1',
        providerPayoutBatchId: 'batch-provider-1',
        senderBatchId: 'sender-1',
        senderItemId: 'sender-item-1',
        payoutStatus: 'succeeded',
        amount: { currency: 'USD', amountMinor: '1000' },
        providerTransactionId: 'txn-1',
        providerFee: { currency: 'USD', amountMinor: '25' },
        failureCode: null,
        failureMessage: null,
      }),
      ...subscriptionLookup,
      ...sellerLookup,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    const updatedItem = await store.findOperationById(item.operationId);
    expect(updatedItem?.payoutStatus).toBe('succeeded');
    expect(updatedItem?.providerFeeMinor).toBe('25');
  });

  it('reconciles uncertain subscription operations using read-only provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const subScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const subscription = await store.createOperation({
      idempotencyKey: 'sub-reconcile',
      idempotencyScope: subScope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'subscription',
      providerSubscriptionId: 'SUB-RECON-1',
      subscriptionStatus: 'approval_pending',
    });
    await store.transitionOperation({
      operationId: subscription.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'seed uncertain subscription',
    });

    const getSubscription = vi.fn().mockResolvedValue({
      providerSubscriptionId: 'SUB-RECON-1',
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
      ...sellerLookup,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    expect(getSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'SUB-RECON-1' }),
    );
    const updated = await store.findOperationById(subscription.operationId);
    expect(updated?.subscriptionStatus).toBe('active');
  });

  it('uses read-only product and plan lookups without mutation RPCs during reconciliation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const productScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'catalog_product',
    });
    const product = await store.createOperation({
      idempotencyKey: 'prod-reconcile',
      idempotencyScope: productScope,
      commandFingerprint: 'fp-prod',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'catalog_product',
      providerProductId: 'PROD-RECON-1',
    });
    await store.transitionOperation({
      operationId: product.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'seed uncertain product',
    });

    const getProduct = vi.fn().mockResolvedValue({
      providerProductId: 'PROD-RECON-1',
      productStatus: 'created',
    });
    const getPlan = vi.fn();
    const getSubscription = vi.fn();

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
      getProduct,
      getPlan,
      getSubscription,
      ...sellerLookup,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    expect(getProduct).toHaveBeenCalledTimes(1);
    expect(getPlan).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it('reconciles uncertain seller referrals with GET only and never treats them as orders', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const referralScope = buildOperationIdempotencyScope({
      applicationRef: 'edc',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'seller_referral',
    });
    const referral = await store.createOperation({
      idempotencyKey: 'seller-reconcile',
      idempotencyScope: referralScope,
      commandFingerprint: 'fp-seller',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'seller_referral',
      providerReferralId: 'REF-RECON-1',
      sellerRef: 'seller-a',
    });
    await store.transitionOperation({
      operationId: referral.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'seed uncertain seller referral',
    });

    const getReferral = vi.fn().mockResolvedValue({
      providerReferralId: 'REF-RECON-1',
      actionUrl: 'https://paypal.example/action',
    });
    const getOrder = vi.fn();
    const findMerchantByTrackingId = vi.fn();
    const getMerchantStatus = vi.fn();

    const service = new ReconciliationService(store, {
      getOrder,
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
      ...subscriptionLookup,
      getReferral,
      findMerchantByTrackingId,
      getMerchantStatus,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBe(1);
    expect(getReferral).toHaveBeenCalledWith(
      expect.objectContaining({ providerReferralId: 'REF-RECON-1' }),
    );
    expect(getOrder).not.toHaveBeenCalled();
    expect(findMerchantByTrackingId).not.toHaveBeenCalled();
    expect(getMerchantStatus).not.toHaveBeenCalled();
    const updated = await store.findOperationById(referral.operationId);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.kind).toBe('seller_referral');
    expect(updated?.approvalUrl).toBe('https://paypal.example/action');
  });

  it('reconciles seller connections through merchant status GET during generic reconcile', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await store.createSellerConnection({
      applicationRef: 'edc',
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
    });
    const getReferral = vi.fn();
    const findMerchantByTrackingId = vi.fn().mockResolvedValue({
      providerMerchantId: 'MERCHANT-RECON-1',
      trackingId: 'seller-a',
      matchCount: 1,
      ambiguous: false,
    });
    const getMerchantStatus = vi.fn().mockResolvedValue({
      providerMerchantId: 'MERCHANT-RECON-1',
      trackingId: 'seller-a',
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      grantedScopes: [
        'https://uri.paypal.com/services/payments/realtimepayment',
        'https://uri.paypal.com/services/payments/refund',
      ],
      productActive: true,
      hasLimitations: false,
      consentPresent: true,
    });

    const service = new ReconciliationService(store, {
      getOrder: vi.fn(),
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
        senderItemId: 'seller-item-1',
        payoutStatus: 'unknown',
        amount: null,
        providerTransactionId: null,
        providerFee: null,
        failureCode: null,
        failureMessage: null,
      }),
      ...subscriptionLookup,
      getReferral,
      findMerchantByTrackingId,
      getMerchantStatus,
    });

    const result = await service.reconcile(10);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(getMerchantStatus).toHaveBeenCalled();
    expect(getReferral).not.toHaveBeenCalled();
    const connection = await store.findSellerConnectionBySellerRef(
      'edc',
      'paypal',
      'default',
      'sandbox',
      'seller-a',
    );
    expect(connection?.readinessReady).toBe(true);
    expect(connection?.connectionStatus).toBe('active');
  });
});
