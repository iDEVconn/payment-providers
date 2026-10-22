import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../../contracts/index';
import { applySubscriptionDomainUpdate } from '../subscription-evidence-application';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';
import { readSubscriptionProviderStateWatermark } from '../subscription-transition-policy';

describe('WebhookProcessingService', () => {
  it('keeps evidence pending and throws when verification is unavailable', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);

    await expect(
      service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}',
        providerEventId: 'tx-unavailable',
        verify: async () => ({
          verified: false,
          transmissionId: 'tx-unavailable',
          eventType: null,
          resourceId: null,
          unavailableReason: 'PayPal webhook verification HTTP 503',
          failureKind: 'verification_unavailable',
        }),
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE });

    const evidence = await store.findEvidenceByProviderEvent(
      'paypal',
      'default',
      'sandbox',
      'tx-unavailable',
    );
    expect(evidence?.verificationStatus).toBe('pending');
    expect(evidence?.errorCode).toBe(PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE);
  });

  it('resumes verification for evidence left pending after a prior unavailable attempt', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-resume',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'capture-resume',
      providerCaptureId: 'capture-resume',
      providerOrderId: 'order-resume',
    });

    await expect(
      service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-resume"}}',
        providerEventId: 'tx-resume',
        verify: async () => ({
          verified: false,
          transmissionId: 'tx-resume',
          eventType: null,
          resourceId: null,
          unavailableReason: 'timeout',
          failureKind: 'verification_unavailable',
        }),
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE });

    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-resume"}}',
      providerEventId: 'tx-resume',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-resume',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'capture-resume',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    expect(receipt.duplicate).toBe(false);
  });

  it('rejects unverified webhook delivery without mutating operations', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);

    await expect(
      service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}',
        providerEventId: 'tx-1',
        verify: async () => ({
          verified: false,
          transmissionId: 'tx-1',
          eventType: null,
          resourceId: null,
          unavailableReason: 'invalid signature',
        }),
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);

    const evidence = await store.findEvidenceByProviderEvent(
      'paypal',
      'default',
      'sandbox',
      'tx-1',
    );
    expect(evidence?.verificationStatus).toBe('rejected');
    expect(await store.findOperationById('missing')).toBeNull();
  });

  it('returns duplicate receipt without a second transition', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'capture-1',
      providerCaptureId: 'capture-1',
      providerOrderId: 'order-1',
    });

    const first = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-1"}}',
      providerEventId: 'tx-2',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-2',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'capture-1',
      }),
    });
    await store.updateEvidence({
      evidenceId: first.evidenceId,
      consumerDeliveryStatus: 'confirmed',
      consumerDeliveredAt: new Date().toISOString(),
    });
    const second = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-1"}}',
      providerEventId: 'tx-2',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-2',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'capture-1',
      }),
    });

    expect(first.processingStatus).toBe('processed');
    expect(second.duplicate).toBe(true);
    const operation = await store.findOperationByProviderCaptureId(
      'paypal',
      'default',
      'sandbox',
      'capture-1',
    );
    if (!operation) {
      throw new Error('expected operation');
    }
    expect((await store.listOperationTransitions(operation.operationId)).length).toBe(1);
  });

  it('updates payout item webhooks and refreshes batch aggregate', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const batchScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
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
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_batch',
      payoutStatus: 'accepted',
      providerPayoutBatchId: 'batch-provider-1',
    });
    const itemScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'payout_item',
    });
    await store.createOperation({
      idempotencyKey: 'item-1',
      idempotencyScope: itemScope,
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      payoutStatus: 'pending',
      providerPayoutItemId: 'item-provider-1',
    });

    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody:
        '{"event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"id":"item-provider-1"}}',
      providerEventId: 'tx-payout-1',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-payout-1',
        eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
        resourceId: 'item-provider-1',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    const item = await store.findOperationByProviderPayoutItemId(
      'paypal',
      'default',
      'sandbox',
      'item-provider-1',
    );
    expect(item?.payoutStatus).toBe('succeeded');
    const updatedBatch = await store.findOperationById(batch.operationId);
    expect(updatedBatch?.payoutStatus).toBe('succeeded');
  });

  it('updates subscription lifecycle without treating payment sale events as activation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const operation = await store.createOperation({
      idempotencyKey: 'sub-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'sub-provider-1',
    });
    await store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: 1,
      nextStatus: 'submitted',
      reason: 'seed',
    });

    const lifecycleReceipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"sub-provider-1"}}',
      providerEventId: 'tx-sub-1',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-sub-1',
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: 'sub-provider-1',
      }),
    });
    expect(lifecycleReceipt.processingStatus).toBe('processed');
    const activated = await store.findOperationByProviderSubscriptionId(
      'paypal',
      'default',
      'sandbox',
      'sub-provider-1',
    );
    expect(activated?.subscriptionStatus).toBe('active');

    const paymentReceipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody:
        '{"event_type":"PAYMENT.SALE.COMPLETED","resource":{"id":"sale-1","billing_agreement_id":"sub-provider-1"}}',
      providerEventId: 'tx-sub-sale-1',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-sub-sale-1',
        eventType: 'PAYMENT.SALE.COMPLETED',
        resourceId: 'sale-1',
      }),
    });
    expect(paymentReceipt.processingStatus).toBe('processed');
    const afterPayment = await store.findOperationByProviderSubscriptionId(
      'paypal',
      'default',
      'sandbox',
      'sub-provider-1',
    );
    expect(afterPayment?.subscriptionStatus).toBe('active');
  });

  it('processes subscription suspend, cancel, expire, and plan lifecycle webhooks', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const subScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const subscription = await store.createOperation({
      idempotencyKey: 'sub-life',
      idempotencyScope: subScope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
      subscriptionStatus: 'active',
      providerSubscriptionId: 'sub-life-1',
    });
    await store.transitionOperation({
      operationId: subscription.operationId,
      expectedVersion: 1,
      nextStatus: 'succeeded',
      reason: 'seed active',
    });

    await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"BILLING.SUBSCRIPTION.SUSPENDED","resource":{"id":"sub-life-1"}}',
      providerEventId: 'tx-sub-suspend',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-sub-suspend',
        eventType: 'BILLING.SUBSCRIPTION.SUSPENDED',
        resourceId: 'sub-life-1',
      }),
    });
    expect(
      (
        await store.findOperationByProviderSubscriptionId(
          'paypal',
          'default',
          'sandbox',
          'sub-life-1',
        )
      )?.subscriptionStatus,
    ).toBe('suspended');

    await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"BILLING.SUBSCRIPTION.CANCELLED","resource":{"id":"sub-life-1"}}',
      providerEventId: 'tx-sub-cancel',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-sub-cancel',
        eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
        resourceId: 'sub-life-1',
      }),
    });
    expect(
      (
        await store.findOperationByProviderSubscriptionId(
          'paypal',
          'default',
          'sandbox',
          'sub-life-1',
        )
      )?.subscriptionStatus,
    ).toBe('cancelled');

    const planScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'billing_plan',
    });
    const plan = await store.createOperation({
      idempotencyKey: 'plan-life',
      idempotencyScope: planScope,
      commandFingerprint: 'fp-plan',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'billing_plan',
      planStatus: 'created',
      providerPlanId: 'plan-life-1',
    });
    await store.transitionOperation({
      operationId: plan.operationId,
      expectedVersion: 1,
      nextStatus: 'submitted',
      reason: 'seed plan',
    });

    await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"BILLING.PLAN.ACTIVATED","resource":{"id":"plan-life-1"}}',
      providerEventId: 'tx-plan-active',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-plan-active',
        eventType: 'BILLING.PLAN.ACTIVATED',
        resourceId: 'plan-life-1',
      }),
    });
    expect(
      (await store.findOperationByProviderPlanId('paypal', 'default', 'sandbox', 'plan-life-1'))
        ?.planStatus,
    ).toBe('active');
  });

  describe('verified cancellation on a succeeded active subscription', () => {
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const providerSubId = 'sub-cancel-propagation-1';

    async function seedSucceededActiveSubscription(store: MemoryPaymentReliabilityStore) {
      const subScope = buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'subscription',
      });
      const subscription = await store.createOperation({
        idempotencyKey: 'sub-cancel-prop',
        idempotencyScope: subScope,
        commandFingerprint: 'fp-sub-cancel-prop',
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        kind: 'subscription',
        subscriptionStatus: 'active',
        providerSubscriptionId: providerSubId,
        subscriberRef: accountId,
        offeringRef: 'campaign_creator_individual_monthly_v1',
        lifecycleReason: 'Existing lifecycle reason',
        providerReferenceId: providerSubId,
      });
      return store.transitionOperation({
        operationId: subscription.operationId,
        expectedVersion: subscription.version,
        nextStatus: 'succeeded',
        reason: 'seed active',
      });
    }

    async function receiveVerifiedCancelledWebhook(
      service: WebhookProcessingService,
      providerEventId: string,
    ) {
      return service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
          resource: { id: providerSubId },
        }),
        providerEventId,
        verify: async () => ({
          verified: true,
          transmissionId: providerEventId,
          eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
          resourceId: providerSubId,
        }),
      });
    }

    it('persists cancelled subscription status without changing execution status', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const service = new WebhookProcessingService(store);
      const before = await seedSucceededActiveSubscription(store);
      const transitionsBefore = await store.listOperationTransitions(before.operationId);

      await receiveVerifiedCancelledWebhook(service, 'tx-sub-cancel-prop-1');

      const updated = await store.findOperationByProviderSubscriptionId(
        'paypal',
        'default',
        'sandbox',
        providerSubId,
      );
      expect(updated?.status).toBe('succeeded');
      expect(updated?.subscriptionStatus).toBe('cancelled');
      expect(updated?.version).toBe(before.version + 1);
      expect(updated?.offeringRef).toBe('campaign_creator_individual_monthly_v1');
      expect(updated?.subscriberRef).toBe(accountId);
      expect(updated?.lifecycleReason).toBe('Existing lifecycle reason');

      const transitionsAfter = await store.listOperationTransitions(before.operationId);
      expect(transitionsAfter).toHaveLength(transitionsBefore.length);
    });

    it('uses domain-only updateOperation for cancelled evidence on succeeded operations', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const updateSpy = vi.spyOn(store, 'updateOperation');
      const transitionSpy = vi.spyOn(store, 'transitionOperation');
      const service = new WebhookProcessingService(store);
      await seedSucceededActiveSubscription(store);

      await receiveVerifiedCancelledWebhook(service, 'tx-sub-cancel-prop-spy');

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionStatus: 'cancelled',
        }),
      );
      expect(transitionSpy.mock.calls.some((call) => call[0]?.nextStatus === 'failed')).toBe(false);
    });

    it('applySubscriptionDomainUpdate passes lifecycleReason through updateOperation', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const updateSpy = vi.spyOn(store, 'updateOperation');
      const operation = await seedSucceededActiveSubscription(store);

      await applySubscriptionDomainUpdate(store, operation, {
        subscriptionStatus: 'cancelled',
        lifecycleReason: 'Advertiser requested subscription cancellation',
        reason: 'PayPal subscription subscription_cancel',
      });

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionStatus: 'cancelled',
          lifecycleReason: 'Advertiser requested subscription cancellation',
        }),
      );
    });

    it('rejects stale expectedVersion on domain-only update', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const operation = await seedSucceededActiveSubscription(store);

      await expect(
        store.updateOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version - 1,
          subscriptionStatus: 'cancelled',
        }),
      ).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
      });
    });

    it('treats duplicate provider events and repeated cancelled webhooks as idempotent', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const service = new WebhookProcessingService(store);
      const before = await seedSucceededActiveSubscription(store);

      const first = await receiveVerifiedCancelledWebhook(service, 'tx-sub-cancel-prop-dup');
      expect(first.duplicate).toBe(false);
      await store.updateEvidence({
        evidenceId: first.evidenceId,
        consumerDeliveryStatus: 'confirmed',
        consumerDeliveredAt: new Date().toISOString(),
      });

      const duplicate = await receiveVerifiedCancelledWebhook(service, 'tx-sub-cancel-prop-dup');
      expect(duplicate.duplicate).toBe(true);

      const afterDuplicate = await store.findOperationById(before.operationId);
      expect(afterDuplicate?.version).toBe(before.version + 1);

      await receiveVerifiedCancelledWebhook(service, 'tx-sub-cancel-prop-second');
      const afterSecond = await store.findOperationById(before.operationId);
      expect(afterSecond?.subscriptionStatus).toBe('cancelled');
      expect(afterSecond?.version).toBe(before.version + 1);
    });

    it('does not mutate operations for rejected or unmatched cancellation evidence', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const service = new WebhookProcessingService(store);
      const before = await seedSucceededActiveSubscription(store);

      await expect(
        service.receiveWebhook({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'test-app',
          environment: 'sandbox',
          rawBody: JSON.stringify({
            event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
            resource: { id: providerSubId },
          }),
          providerEventId: 'tx-sub-cancel-rejected',
          verify: async () => ({
            verified: false,
            transmissionId: 'tx-sub-cancel-rejected',
            eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
            resourceId: providerSubId,
            unavailableReason: 'invalid signature',
          }),
        }),
      ).rejects.toBeInstanceOf(PaymentReliabilityError);

      const afterRejected = await store.findOperationById(before.operationId);
      expect(afterRejected?.subscriptionStatus).toBe('active');
      expect(afterRejected?.version).toBe(before.version);

      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
          resource: { id: 'unknown-subscription-id' },
        }),
        providerEventId: 'tx-sub-cancel-unmatched',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-cancel-unmatched',
          eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
          resourceId: 'unknown-subscription-id',
        }),
      });

      const evidence = await store.findEvidenceByProviderEvent(
        'paypal',
        'default',
        'sandbox',
        'tx-sub-cancel-unmatched',
      );
      expect(evidence?.processingStatus).toBe('unmatched');

      const afterUnmatched = await store.findOperationById(before.operationId);
      expect(afterUnmatched?.subscriptionStatus).toBe('active');
      expect(afterUnmatched?.version).toBe(before.version);
    });
  });

  describe('subscription webhook provider refresh', () => {
    const providerSubId = 'sub-provider-refresh-1';
    const providerStart = '2026-05-01T12:00:00.000Z';
    const providerNextBilling = '2026-06-01T12:00:00.000Z';
    const providerStateAt = '2026-05-01T12:30:00.000Z';

    async function seedSubscription(store: MemoryPaymentReliabilityStore) {
      const scope = buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'subscription',
      });
      const operation = await store.createOperation({
        idempotencyKey: 'sub-refresh',
        idempotencyScope: scope,
        commandFingerprint: 'fp-sub-refresh',
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        kind: 'subscription',
        subscriptionStatus: 'approval_pending',
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-1',
      });
      return store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'submitted',
        reason: 'seed',
      });
    }

    it('ACTIVATED refreshes and persists billing dates from provider GET', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: providerStart,
        nextBillingTime: providerNextBilling,
        lifecycleReason: null,
        providerSubscriptionStateAt: providerStateAt,
      });
      const service = new WebhookProcessingService(store, { getSubscription });
      await seedSubscription(store);

      const receipt = await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: providerSubId, update_time: '1999-01-01T00:00:00Z' },
        }),
        providerEventId: 'tx-sub-activated-billing',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-activated-billing',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: providerSubId,
        }),
      });
      expect(receipt.processingStatus).toBe('processed');
      expect(getSubscription).toHaveBeenCalled();

      const reloaded = await store.findOperationByProviderSubscriptionId(
        'paypal',
        'default',
        'sandbox',
        providerSubId,
      );
      expect(reloaded?.subscriptionStatus).toBe('active');
      expect(reloaded?.startTime).toBe(providerStart);
      expect(reloaded?.nextBillingTime).toBe(providerNextBilling);
      expect(reloaded?.providerSubscriptionStateAt).toBe(providerStateAt);
    });

    it('UPDATED refreshes billing dates without inventing a lifecycle status', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const seeded = await seedSubscription(store);
      await store.transitionOperation({
        operationId: seeded.operationId,
        expectedVersion: seeded.version,
        nextStatus: 'succeeded',
        subscriptionStatus: 'active',
        startTime: '2026-01-01T00:00:00.000Z',
        nextBillingTime: '2026-02-01T00:00:00.000Z',
        reason: 'activate',
      });

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: providerStart,
        nextBillingTime: providerNextBilling,
        lifecycleReason: null,
        providerSubscriptionStateAt: providerStateAt,
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      const receipt = await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.UPDATED',
          resource: { id: providerSubId },
        }),
        providerEventId: 'tx-sub-updated-billing',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-updated-billing',
          eventType: 'BILLING.SUBSCRIPTION.UPDATED',
          resourceId: providerSubId,
        }),
      });
      expect(receipt.processingStatus).toBe('processed');

      const reloaded = await store.findOperationById(seeded.operationId);
      expect(reloaded?.subscriptionStatus).toBe('active');
      expect(reloaded?.startTime).toBe(providerStart);
      expect(reloaded?.nextBillingTime).toBe(providerNextBilling);
    });

    it('preserves stored billing dates when provider GET omits them', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const existingStart = '2026-03-01T00:00:00.000Z';
      const existingNextBilling = '2026-04-01T00:00:00.000Z';
      const seeded = await seedSubscription(store);
      await store.transitionOperation({
        operationId: seeded.operationId,
        expectedVersion: seeded.version,
        nextStatus: 'succeeded',
        subscriptionStatus: 'active',
        startTime: existingStart,
        nextBillingTime: existingNextBilling,
        reason: 'activate',
      });

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: null,
        nextBillingTime: null,
        lifecycleReason: null,
        providerSubscriptionStateAt: providerStateAt,
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.UPDATED',
          resource: { id: providerSubId },
        }),
        providerEventId: 'tx-sub-updated-preserve',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-updated-preserve',
          eventType: 'BILLING.SUBSCRIPTION.UPDATED',
          resourceId: providerSubId,
        }),
      });

      const reloaded = await store.findOperationById(seeded.operationId);
      expect(reloaded?.startTime).toBe(existingStart);
      expect(reloaded?.nextBillingTime).toBe(existingNextBilling);
    });

    it('leaves evidence recoverable when provider GET fails', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const seeded = await seedSubscription(store);
      const before = await store.findOperationById(seeded.operationId);

      const getSubscription = vi
        .fn()
        .mockRejectedValue(
          new PaymentReliabilityError(
            PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
            'PayPal subscription lookup unavailable',
          ),
        );
      const service = new WebhookProcessingService(store, { getSubscription });

      const receipt = await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: providerSubId },
        }),
        providerEventId: 'tx-sub-get-fail',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-get-fail',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: providerSubId,
        }),
      });
      expect(receipt.processingStatus).toBe('pending');

      const after = await store.findOperationById(seeded.operationId);
      expect(after?.subscriptionStatus).toBe(before?.subscriptionStatus);
      expect(after?.startTime).toBe(before?.startTime);
      expect(after?.version).toBe(before?.version);
    });

    it('ignores stale provider snapshots using GET state timestamps, not event timestamps', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const seeded = await seedSubscription(store);
      const tNew = '2026-06-02T12:00:00.000Z';
      const tOld = '2026-06-01T12:00:00.000Z';
      await store.transitionOperation({
        operationId: seeded.operationId,
        expectedVersion: seeded.version,
        nextStatus: 'succeeded',
        subscriptionStatus: 'active',
        providerSubscriptionStateAt: tNew,
        reason: 'seed active watermark',
      });

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'suspended',
        approvalUrl: null,
        startTime: null,
        nextBillingTime: null,
        lifecycleReason: null,
        providerSubscriptionStateAt: tOld,
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
          resource: { id: providerSubId, update_time: '2099-01-01T00:00:00Z' },
        }),
        providerEventId: 'tx-sub-stale-get',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-stale-get',
          eventType: 'BILLING.SUBSCRIPTION.SUSPENDED',
          resourceId: providerSubId,
        }),
      });

      const reloaded = await store.findOperationById(seeded.operationId);
      expect(reloaded?.subscriptionStatus).toBe('active');
      expect(readSubscriptionProviderStateWatermark(reloaded)).toBe(tNew);
    });

    it('rejects provider snapshots with a mismatched plan id and keeps evidence recoverable', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const seeded = await seedSubscription(store);
      const before = await store.findOperationById(seeded.operationId);

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: 'PLAN-OTHER',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: providerStart,
        nextBillingTime: providerNextBilling,
        lifecycleReason: null,
        providerSubscriptionStateAt: providerStateAt,
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      const receipt = await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: providerSubId },
        }),
        providerEventId: 'tx-sub-plan-mismatch',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-plan-mismatch',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: providerSubId,
        }),
      });

      expect(receipt.processingStatus).toBe('pending');
      const evidence = await store.findEvidenceByProviderEvent(
        'paypal',
        'default',
        'sandbox',
        'tx-sub-plan-mismatch',
      );
      expect(evidence?.errorCode).toBe(PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH);

      const after = await store.findOperationById(seeded.operationId);
      expect(after?.providerPlanId).toBe(before?.providerPlanId);
      expect(after?.subscriptionStatus).toBe(before?.subscriptionStatus);
      expect(after?.startTime).toBe(before?.startTime);
      expect(after?.nextBillingTime).toBe(before?.nextBillingTime);
      expect(after?.version).toBe(before?.version);
    });

    it('preserves stored plan id when provider GET omits plan id', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const seeded = await seedSubscription(store);

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: providerSubId,
        providerPlanId: null,
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: providerStart,
        nextBillingTime: providerNextBilling,
        lifecycleReason: null,
        providerSubscriptionStateAt: providerStateAt,
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: providerSubId },
        }),
        providerEventId: 'tx-sub-missing-plan',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-missing-plan',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: providerSubId,
        }),
      });

      const reloaded = await store.findOperationById(seeded.operationId);
      expect(reloaded?.providerPlanId).toBe('PLAN-1');
      expect(reloaded?.startTime).toBe(providerStart);
    });

    it('does not reactivate cancelled subscriptions when provider GET reports active', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const subScope = buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'subscription',
      });
      const subscription = await store.createOperation({
        idempotencyKey: 'sub-terminal-get',
        idempotencyScope: subScope,
        commandFingerprint: 'fp-sub',
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        kind: 'subscription',
        subscriptionStatus: 'cancelled',
        providerSubscriptionId: 'sub-terminal-get-1',
      });
      await store.transitionOperation({
        operationId: subscription.operationId,
        expectedVersion: 1,
        nextStatus: 'failed',
        reason: 'seed cancelled',
      });

      const getSubscription = vi.fn().mockResolvedValue({
        providerSubscriptionId: 'sub-terminal-get-1',
        providerPlanId: 'PLAN-1',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: null,
        nextBillingTime: null,
        lifecycleReason: null,
        providerSubscriptionStateAt: '2026-08-01T00:00:00.000Z',
      });
      const service = new WebhookProcessingService(store, { getSubscription });

      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody:
          '{"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"sub-terminal-get-1"}}',
        providerEventId: 'tx-sub-terminal-get',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx-sub-terminal-get',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: 'sub-terminal-get-1',
        }),
      });

      expect(
        (
          await store.findOperationByProviderSubscriptionId(
            'paypal',
            'default',
            'sandbox',
            'sub-terminal-get-1',
          )
        )?.subscriptionStatus,
      ).toBe('cancelled');
    });
  });

  it('correlates PayPal payout webhooks when resource.id is a WH envelope id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const batch = await store.createOperation({
      idempotencyKey: 'batch-paypal',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp-batch',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_batch',
      payoutStatus: 'accepted',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
      senderBatchId: 'batch_sender_1',
    });
    const item = await store.createOperation({
      idempotencyKey: 'item-paypal',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_item',
      }),
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      senderItemId: 'sender_item_1',
      amountMinor: '392',
      currencyCode: 'USD',
      recipientValue: 'creator@example.com',
      payoutStatus: 'pending',
    });

    const unclaimedPayload = JSON.stringify({
      event_type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
      resource: {
        id: 'WH-UNCLAIMED',
        payout_batch_id: 'QJBZAQ9NCX6X4',
        payout_item_id: 'L6V2ER6KKB4CS',
        sender_item_id: 'sender_item_1',
        payout_item: {
          amount: { currency: 'USD', value: '3.92' },
          receiver: 'creator@example.com',
        },
        payout_item_fee: { currency: 'USD', value: '0.08' },
      },
    });

    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: unclaimedPayload,
      providerEventId: 'tx-unclaimed',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-unclaimed',
        eventType: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
        resourceId: 'WH-UNCLAIMED',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    const updatedItem = await store.findOperationById(item.operationId);
    expect(updatedItem?.payoutStatus).toBe('unclaimed');
    expect(updatedItem?.providerPayoutItemId).toBe('L6V2ER6KKB4CS');
    expect(updatedItem?.providerFeeMinor).toBeNull();
  });

  it('records stale payout evidence as processed without regressing stronger item status', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const batch = await store.createOperation({
      idempotencyKey: 'batch-stale',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp-batch',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
    });
    const item = await store.createOperation({
      idempotencyKey: 'item-stale',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_item',
      }),
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      senderItemId: 'sender_item_1',
      amountMinor: '392',
      currencyCode: 'USD',
      recipientValue: 'creator@example.com',
      providerPayoutItemId: 'L6V2ER6KKB4CS',
      payoutStatus: 'succeeded',
      status: 'succeeded',
    });

    const stalePayload = JSON.stringify({
      event_type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
      resource: {
        id: 'WH-STALE',
        payout_batch_id: 'QJBZAQ9NCX6X4',
        payout_item_id: 'L6V2ER6KKB4CS',
        sender_item_id: 'sender_item_1',
        payout_item: {
          amount: { currency: 'USD', value: '3.92' },
          receiver: 'creator@example.com',
        },
      },
    });

    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: stalePayload,
      providerEventId: 'tx-stale',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-stale',
        eventType: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
        resourceId: 'WH-STALE',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    const unchanged = await store.findOperationById(item.operationId);
    expect(unchanged?.payoutStatus).toBe('succeeded');
  });

  it('reprocesses stored unmatched payout evidence without calling PayPal', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const batch = await store.createOperation({
      idempotencyKey: 'batch-replay',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'test-app',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp-batch',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
    });
    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-replay',
      rawPayload: JSON.stringify({
        resource: {
          id: 'WH-BATCH',
          batch_header: {
            payout_batch_id: 'QJBZAQ9NCX6X4',
            sender_batch_header: { sender_batch_id: 'batch_sender_1' },
          },
        },
      }),
      payloadSha256: 'sha',
      eventType: 'PAYMENT.PAYOUTSBATCH.PROCESSING',
      resourceId: 'WH-BATCH',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'unmatched',
    });

    const result = await service.reprocessVerifiedUnmatchedPayoutEvidence({
      evidenceIds: [evidence.evidenceId],
    });
    expect(result).toEqual({ processed: 1, skipped: 0, unmatched: 0 });
    const updatedBatch = await store.findOperationById(batch.operationId);
    expect(updatedBatch?.payoutStatus).toBe('processing');
    const updatedEvidence = await store.findEvidenceById(evidence.evidenceId);
    expect(updatedEvidence?.processingStatus).toBe('processed');
    expect(updatedEvidence?.resourceId).toBe('QJBZAQ9NCX6X4');
  });

  it('does not reactivate cancelled subscriptions from out-of-order activation webhooks', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const subScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const subscription = await store.createOperation({
      idempotencyKey: 'sub-terminal',
      idempotencyScope: subScope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
      subscriptionStatus: 'cancelled',
      providerSubscriptionId: 'sub-terminal-1',
    });
    await store.transitionOperation({
      operationId: subscription.operationId,
      expectedVersion: 1,
      nextStatus: 'failed',
      reason: 'seed cancelled',
    });

    const result = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"sub-terminal-1"}}',
      providerEventId: 'tx-sub-reactivate',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-sub-reactivate',
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: 'sub-terminal-1',
      }),
    });
    expect(result.duplicate).toBe(false);

    expect(
      (
        await store.findOperationByProviderSubscriptionId(
          'paypal',
          'default',
          'sandbox',
          'sub-terminal-1',
        )
      )?.subscriptionStatus,
    ).toBe('cancelled');
  });
});
