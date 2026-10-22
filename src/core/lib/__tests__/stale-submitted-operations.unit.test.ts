import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, type PaymentOperation } from '../../../contracts/index';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { ReconciliationService } from '../reconciliation-service';
import { DEFAULT_SUBMITTED_STALE_AFTER_MS } from '../retry-backoff';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';

/*
 * Issue #12 (remainder): a crash between the claim (`submitted`) and the result write left the
 * operation `submitted` forever. Ports probe p3 "crashed after claim".
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

const T0 = Date.parse('2026-10-22T12:00:00.000Z');

const lookup = {
  getSubscription: vi.fn(async () => {
    throw new Error('no lookup without a provider id');
  }),
} as unknown as ReconciliationProviderLookup;

async function crashedAfterClaim(
  store: MemoryPaymentReliabilityStore,
  idempotencyKey = 'z',
): Promise<PaymentOperation> {
  const op = await store.createOperation({
    ...ctx,
    idempotencyKey,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp',
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerPlanId: 'P-1',
  });
  return store.claimOperationForExecution({
    operationId: op.operationId,
    expectedVersion: op.version,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('stale submitted operations (issue #12)', () => {
  it('listUncertainOperations includes a submitted operation older than submittedStaleBefore (probe p3)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const claimed = await crashedAfterClaim(store);
    expect(claimed.status).toBe('submitted');

    expect(await store.listUncertainOperations(25)).toEqual([]);
    expect(
      await store.listUncertainOperations(25, {
        submittedStaleBefore: new Date(T0 - 1).toISOString(),
      }),
    ).toEqual([]);
    const stale = await store.listUncertainOperations(25, {
      submittedStaleBefore: new Date(T0).toISOString(),
    });
    expect(stale.map((operation) => operation.operationId)).toEqual([claimed.operationId]);
  });

  it('never lists a submitted operation with a provider reference or an unexpired execution lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const awaitingApproval = await crashedAfterClaim(store, 'approval');
    await store.transitionOperation({
      operationId: awaitingApproval.operationId,
      expectedVersion: awaitingApproval.version,
      nextStatus: 'submitted',
      providerSubscriptionId: 'I-APPROVAL',
      providerReferenceId: 'I-APPROVAL',
      reason: 'created, awaiting buyer approval',
    });
    const created = await store.createOperation({
      ...ctx,
      idempotencyKey: 'leased',
      idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      commandFingerprint: 'fp',
      kind: 'subscription',
      providerPlanId: 'P-1',
    });
    await store.acquireCheckoutCreateExecutionLease({
      operationId: created.operationId,
      expectedVersion: created.version,
    });

    vi.setSystemTime(T0 + 10_000);
    expect(
      await store.listUncertainOperations(25, {
        submittedStaleBefore: new Date(T0 + 5_000).toISOString(),
      }),
    ).toEqual([]);
  });

  it('reconcile marks a crashed create unknown after submittedStaleAfterMs so it can be retried', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    expect(DEFAULT_SUBMITTED_STALE_AFTER_MS).toBe(300_000);
    const store = new MemoryPaymentReliabilityStore();
    const request = {
      ...ctx,
      idempotencyKey: 'sub-crash',
      providerPlanId: 'P-1',
      offeringRef: 'pro',
      subscriber: { subscriberRef: 'u1', email: 'a@b.c' },
    };
    const getPlan = vi.fn(async () => ({
      providerPlanId: 'P-1',
      providerProductId: 'PROD-1',
      planStatus: 'active' as const,
    }));
    // The worker dies while PayPal is answering: the create never returns.
    const crashed = new SubscriptionLifecycleService(store, {
      getPlan,
      createSubscription: () => new Promise(() => undefined),
    } as unknown as SubscriptionProviderPort);
    void crashed.createSubscription(request);
    await vi.waitFor(async () => {
      const row = await store.findOperationByIdempotency(
        buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
        'sub-crash',
      );
      expect(row?.status).toBe('submitted');
    });
    const claimed = (await store.findOperationByIdempotency(
      buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
      'sub-crash',
    )) as PaymentOperation;
    const reconciliation = new ReconciliationService(store, lookup);
    // vi.waitFor moves the fake clock: count from the claim.
    const claimedAt = Date.parse(claimed.updatedAt);

    vi.setSystemTime(claimedAt + DEFAULT_SUBMITTED_STALE_AFTER_MS - 1);
    expect((await reconciliation.reconcile(25)).examined).toBe(0);
    expect((await store.findOperationById(claimed.operationId))?.status).toBe('submitted');

    vi.setSystemTime(claimedAt + DEFAULT_SUBMITTED_STALE_AFTER_MS);
    expect((await reconciliation.reconcile(25)).examined).toBe(1);
    const stale = await store.findOperationById(claimed.operationId);
    expect(stale).toMatchObject({
      status: 'unknown',
      subscriptionStatus: 'unknown',
      failureCode: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      attempts: 1,
    });
    const history = await store.listOperationTransitions(claimed.operationId);
    expect(history.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual([
      'prepared->submitted',
      'submitted->unknown',
    ]);

    // The host's create retry now recovers it with the same PayPal-Request-Id.
    const createSubscription = vi.fn(async () => ({
      providerSubscriptionId: 'I-RECOVERED',
      providerPlanId: 'P-1',
      subscriptionStatus: 'approval_pending' as const,
      approvalUrl: 'https://paypal.test/approve/I-RECOVERED',
      startTime: null,
      nextBillingTime: null,
    }));
    const lifecycle = new SubscriptionLifecycleService(store, {
      getPlan,
      createSubscription,
    } as unknown as SubscriptionProviderPort);
    const { idempotencyKey: _key, ...retryRequest } = request;
    const retried = await lifecycle.retrySubscriptionCreate(
      { ...retryRequest, subscriptionOperationId: claimed.operationId },
      { evaluateProviderCreateRetryEligibility: () => 'allowed' },
    );
    expect(retried).toMatchObject({
      operationStatus: 'submitted',
      providerSubscriptionId: 'I-RECOVERED',
    });
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerRequestId: claimed.operationId }),
    );
  });

  it('submittedStaleAfterMs is configurable', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const claimed = await crashedAfterClaim(store);
    const reconciliation = new ReconciliationService(
      store,
      lookup,
      {},
      {
        submittedStaleAfterMs: 1_000,
      },
    );
    vi.setSystemTime(T0 + 1_000);
    await reconciliation.reconcile(25);
    expect((await store.findOperationById(claimed.operationId))?.status).toBe('unknown');
  });
});
