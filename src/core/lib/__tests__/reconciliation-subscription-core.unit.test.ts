import { describe, expect, it, vi } from 'vitest';
import type { ExecuteGetSubscriptionResult, PaymentOperation } from '../../../contracts/index';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { ReconciliationService } from '../reconciliation-service';
import {
  readSubscriptionOperationState,
  type SubscriptionEffectsHook,
} from '../subscription-evidence-application';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { sha256Payload } from '../sha256-payload';
import { WebhookProcessingService } from '../webhook-processing-service';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

function snapshot(over: Partial<ExecuteGetSubscriptionResult> = {}): ExecuteGetSubscriptionResult {
  return {
    providerSubscriptionId: 'I-1',
    providerPlanId: 'P-1',
    subscriptionStatus: 'active',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: null,
    ...over,
  };
}

function lookupOf(
  getSubscription: ReconciliationProviderLookup['getSubscription'],
): ReconciliationProviderLookup {
  return { getSubscription } as unknown as ReconciliationProviderLookup;
}

function findBySubscriptionId(store: MemoryPaymentReliabilityStore, id: string) {
  return store.findOperationByProviderSubscriptionId(
    ctx.providerCode,
    ctx.accountRef,
    ctx.environment,
    id,
  );
}

describe('ReconciliationService on the pure core', () => {
  // T5 review finding 1 (probe t5review/tools/p-sale.mjs).
  it('never takes the subscription id from a PAYMENT.SALE resource', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let operation = await store.createOperation({
      ...ctx,
      idempotencyKey: 'k',
      idempotencyScope: 's',
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'active',
      providerSubscriptionId: 'I-1',
      providerPlanId: 'P-1',
    });
    operation = await store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });
    operation = await store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus: 'unknown',
      providerReferenceId: 'I-1',
      reason: 'uncertain',
    });
    const rawPayload = JSON.stringify({
      id: 'WH-S',
      event_type: 'PAYMENT.SALE.COMPLETED',
      resource: {
        id: 'SALE-1',
        billing_agreement_id: 'I-1',
        amount: { total: '10.00', currency: 'USD' },
      },
    });
    const evidence = await store.insertEvidence({
      ...ctx,
      evidenceKind: 'webhook',
      providerEventId: 'WH-S',
      rawPayload,
      payloadSha256: sha256Payload(rawPayload),
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: 'SALE-1',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'unmatched',
      relatedOperationId: operation.operationId,
    });
    const getSubscription = vi.fn<ReconciliationProviderLookup['getSubscription']>(async () =>
      snapshot(),
    );
    const service = new ReconciliationService(store, lookupOf(getSubscription));

    await service.reconcile(10);

    // Final review F13: the lookup uses the subscription id, never the sale id of the evidence.
    expect(getSubscription).toHaveBeenCalled();
    for (const [request] of getSubscription.mock.calls) {
      expect(request.providerSubscriptionId).toBe('I-1');
    }
    const after = await store.findOperationById(operation.operationId);
    expect(after?.providerSubscriptionId).toBe('I-1');
    expect(after?.providerReferenceId).toBe('I-1');
    expect(after?.subscriptionStatus).toBe('active');
    expect((await findBySubscriptionId(store, 'I-1'))?.operationId).toBe(operation.operationId);
    expect(
      (
        await store.findOperationByProviderReference(
          ctx.providerCode,
          ctx.accountRef,
          ctx.environment,
          'I-1',
        )
      )?.operationId,
    ).toBe(operation.operationId);
    expect(readSubscriptionOperationState(after!).lastPayment?.amountMinor).toBe('1000');

    const webhooks = new WebhookProcessingService(store);
    const cancelled = await webhooks.receiveWebhook({
      ...ctx,
      rawBody: JSON.stringify({
        id: 'WH-C',
        event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        resource: { id: 'I-1' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 'WH-C',
        eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
        resourceId: 'I-1',
      }),
    });
    expect(cancelled.processingStatus).toBe('processed');
    expect((await findBySubscriptionId(store, 'I-1'))?.subscriptionStatus).toBe('cancelled');
  });

  // T5 review finding 2 (probe t5review/tools/p-cancel.mjs).
  it('reconciles an uncertain cancel command without binding the subscription reference to it', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = {
      getPlan: async () => ({
        providerPlanId: 'P-1',
        providerProductId: 'PROD-1',
        planStatus: 'active',
      }),
      createSubscription: async () => ({
        providerSubscriptionId: 'I-1',
        providerPlanId: 'P-1',
        subscriptionStatus: 'active',
        approvalUrl: null,
        startTime: null,
        nextBillingTime: null,
      }),
      cancelSubscription: async () => {
        throw { code: 'PROVIDER_UNCERTAIN', message: 'timeout', retryable: true, uncertain: true };
      },
      getSubscription: async () => snapshot({ subscriptionStatus: 'cancelled' }),
    } as unknown as SubscriptionProviderPort;
    const lifecycle = new SubscriptionLifecycleService(store, provider);
    const created = await lifecycle.createSubscription({
      ...ctx,
      idempotencyKey: 'k',
      providerPlanId: 'P-1',
      offeringRef: 'pro',
      subscriber: { subscriberRef: 'u1' },
    });
    await expect(
      lifecycle.cancelSubscription({
        ...ctx,
        idempotencyKey: 'c1',
        subscriptionOperationId: created.subscriptionOperationId,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    const [command] = await store.listUncertainOperations(10);
    expect(command?.kind).toBe('subscription_cancel');

    const result = await new ReconciliationService(
      store,
      provider as unknown as ReconciliationProviderLookup,
    ).reconcile(10);

    expect(result.applied).toBe(1);
    expect(result.retryableFailures).toBe(0);
    const reconciled = await store.findOperationById(command!.operationId);
    expect(reconciled?.status).toBe('succeeded');
    expect(reconciled?.providerReferenceId).toBeNull();
    const subscription = await store.findOperationById(created.subscriptionOperationId);
    expect(subscription?.subscriptionStatus).toBe('cancelled');
    expect(
      (
        await store.findOperationByProviderReference(
          ctx.providerCode,
          ctx.accountRef,
          ctx.environment,
          'I-1',
        )
      )?.kind,
    ).toBe('subscription');
    expect(await store.listUncertainOperations(10)).toEqual([]);
  });

  it('fails an uncertain command when the provider shows it did not take effect', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const subscription = await seedSubscription(store, 'active');
    const command = await seedUncertainCommand(store, subscription, 'subscription_suspend');

    const result = await new ReconciliationService(
      store,
      lookupOf(async () => snapshot({ subscriptionStatus: 'active' })),
    ).reconcile(10);

    expect(result.retryableFailures).toBe(0);
    const reconciled = await store.findOperationById(command.operationId);
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.failureCode).toBe('SUBSCRIPTION_COMMAND_NOT_APPLIED');
    expect(reconciled?.providerReferenceId).toBeNull();
    expect((await store.findOperationById(subscription.operationId))?.subscriptionStatus).toBe(
      'active',
    );
  });

  it('persists last payment and failed payment count from the provider lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: 'sub-lookup-billing',
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-1',
      providerPlanId: 'P-1',
    });
    const uncertain = await store.transitionOperation({
      operationId: created.operationId,
      expectedVersion: created.version,
      nextStatus: 'unknown',
      reason: 'seed uncertain',
    });
    const hook = vi.fn<SubscriptionEffectsHook>();

    const result = await new ReconciliationService(
      store,
      lookupOf(async () =>
        snapshot({
          nextBillingTime: '2026-11-22T10:00:00Z',
          lastPayment: { amountMinor: '999', currency: 'USD', time: '2026-10-22T10:00:00.000Z' },
          failedPaymentsCount: 1,
        }),
      ),
      { onSubscriptionEffects: hook },
    ).reconcile(10);

    expect(result.applied).toBe(1);
    const after = await store.findOperationById(uncertain.operationId);
    expect(after?.status).toBe('succeeded');
    expect(after?.subscriptionStatus).toBe('active');
    expect(after?.nextBillingTime).toBe('2026-11-22T10:00:00Z');
    const state = readSubscriptionOperationState(after!);
    expect(state.lastPayment).toEqual({
      amountMinor: '999',
      currency: 'USD',
      time: '2026-10-22T10:00:00.000Z',
    });
    expect(state.failedPaymentsCount).toBe(1);
    expect(hook).toHaveBeenCalledWith(
      uncertain.operationId,
      expect.arrayContaining([{ type: 'status_changed', from: 'approval_pending', to: 'active' }]),
      expect.objectContaining({ source: 'reconciliation' }),
    );
  });

  it('delivers effects held after a failed reconciliation hook through recovery', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: 'sub-held',
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: 'I-1',
      providerPlanId: 'P-1',
    });
    const uncertain = await store.transitionOperation({
      operationId: created.operationId,
      expectedVersion: created.version,
      nextStatus: 'unknown',
      reason: 'seed uncertain',
    });
    const failingHook = vi.fn<SubscriptionEffectsHook>().mockRejectedValue(new Error('down'));

    await new ReconciliationService(
      store,
      lookupOf(async () => snapshot()),
      { onSubscriptionEffects: failingHook },
    ).reconcile(10);

    expect(failingHook).toHaveBeenCalledTimes(1);
    expect((await store.findOperationById(uncertain.operationId))?.subscriptionStatus).toBe(
      'active',
    );
    const hook = vi.fn<SubscriptionEffectsHook>();
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: new WebhookProcessingService(
        store,
        undefined,
        {},
        {
          onSubscriptionEffects: hook,
        },
      ),
      consumer: null,
    });

    await recovery.recover({ workerId: 'w1' });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[1]).toEqual(failingHook.mock.calls[0]?.[1]);
    const [held] = failingHook.mock.calls;
    const evidence = await store.findEvidenceById(held![2].evidenceId!);
    expect(evidence?.processingStatus).toBe('processed');
    expect(evidence?.errorCode).toBeNull();

    await recovery.recover({ workerId: 'w1' });
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

async function seedSubscription(
  store: MemoryPaymentReliabilityStore,
  subscriptionStatus: 'active',
): Promise<PaymentOperation> {
  const created = await store.createOperation({
    ...ctx,
    idempotencyKey: 'sub-seed',
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp',
    kind: 'subscription',
    subscriptionStatus,
    providerSubscriptionId: 'I-1',
    providerReferenceId: 'I-1',
    providerPlanId: 'P-1',
  });
  return store.transitionOperation({
    operationId: created.operationId,
    expectedVersion: created.version,
    nextStatus: 'succeeded',
    reason: 'seed',
  });
}

async function seedUncertainCommand(
  store: MemoryPaymentReliabilityStore,
  subscription: PaymentOperation,
  kind: 'subscription_suspend',
): Promise<PaymentOperation> {
  const created = await store.createOperation({
    ...ctx,
    idempotencyKey: 'cmd-seed',
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind }),
    commandFingerprint: 'fp-cmd',
    kind,
    parentOperationId: subscription.operationId,
    providerSubscriptionId: 'I-1',
    lifecycleReason: 'x',
  });
  const claimed = await store.claimOperationForExecution({
    operationId: created.operationId,
    expectedVersion: created.version,
  });
  return store.transitionOperation({
    operationId: claimed.operationId,
    expectedVersion: claimed.version,
    nextStatus: 'unknown',
    reason: 'timeout',
  });
}
