import { describe, expect, it } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

const scope = buildOperationIdempotencyScope({
  applicationRef: 'test-app',
  accountRef: 'default',
  environment: 'sandbox',
  kind: 'checkout',
});

describe('MemoryPaymentReliabilityStore', () => {
  it('replays the same idempotency key when the fingerprint matches', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const first = await store.createOperation({
      idempotencyKey: 'idem-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp-1',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'checkout',
    });
    const second = await store.createOperation({
      idempotencyKey: 'idem-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp-1',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'checkout',
    });
    expect(second.operationId).toBe(first.operationId);
  });

  it('conflicts when the same idempotency key has a different fingerprint', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await store.createOperation({
      idempotencyKey: 'idem-1',
      idempotencyScope: scope,
      commandFingerprint: 'fp-1',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'checkout',
    });
    await expect(
      store.createOperation({
        idempotencyKey: 'idem-1',
        idempotencyScope: scope,
        commandFingerprint: 'fp-2',
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        kind: 'checkout',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('detects duplicate provider event ids', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-1',
      rawPayload: '{}',
      payloadSha256: 'abc',
    });
    await expect(
      store.insertEvidence({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        evidenceKind: 'webhook',
        providerEventId: 'evt-1',
        rawPayload: '{}',
        payloadSha256: 'abc',
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_DUPLICATE' });
  });

  it('claims pending evidence with worker ownership and expired lease reuse', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-claim',
      rawPayload: '{}',
      payloadSha256: 'abc',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
    });
    const first = await store.claimPendingEvidence({
      limit: 10,
      leaseMs: 60_000,
      workerId: 'worker-a',
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.claimWorkerId).toBe('worker-a');

    const competing = await store.claimPendingEvidence({
      limit: 10,
      leaseMs: 60_000,
      workerId: 'worker-b',
    });
    expect(competing).toHaveLength(0);

    const sameWorker = await store.claimPendingEvidence({
      limit: 10,
      leaseMs: 60_000,
      workerId: 'worker-a',
    });
    expect(sameWorker).toHaveLength(1);

    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      claimLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const stale = await store.claimPendingEvidence({
      limit: 10,
      leaseMs: 60_000,
      workerId: 'worker-b',
    });
    expect(stale[0]?.claimWorkerId).toBe('worker-b');
  });

  it('finds subscription operations by provider product, plan, and subscription ids with environment isolation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const productScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'catalog_product',
    });
    const product = await store.createOperation({
      idempotencyKey: 'prod-lookup',
      idempotencyScope: productScope,
      commandFingerprint: 'fp-prod',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'catalog_product',
      providerProductId: 'PROD-LOOKUP-1',
    });
    const planScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'billing_plan',
    });
    const plan = await store.createOperation({
      idempotencyKey: 'plan-lookup',
      idempotencyScope: planScope,
      commandFingerprint: 'fp-plan',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'billing_plan',
      parentOperationId: product.operationId,
      providerProductId: 'PROD-LOOKUP-1',
      providerPlanId: 'PLAN-LOOKUP-1',
    });
    const subScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    await store.createOperation({
      idempotencyKey: 'sub-lookup',
      idempotencyScope: subScope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
      parentOperationId: plan.operationId,
      providerPlanId: 'PLAN-LOOKUP-1',
      providerSubscriptionId: 'SUB-LOOKUP-1',
    });

    expect(
      await store.findOperationByProviderProductId('paypal', 'default', 'sandbox', 'PROD-LOOKUP-1'),
    ).toMatchObject({ operationId: product.operationId });
    expect(
      await store.findOperationByProviderPlanId('paypal', 'default', 'sandbox', 'PLAN-LOOKUP-1'),
    ).toMatchObject({ operationId: plan.operationId });
    expect(
      await store.findOperationByProviderSubscriptionId(
        'paypal',
        'default',
        'sandbox',
        'SUB-LOOKUP-1',
      ),
    ).toMatchObject({ providerSubscriptionId: 'SUB-LOOKUP-1' });
    expect(
      await store.findOperationByProviderSubscriptionId(
        'paypal',
        'default',
        'live',
        'SUB-LOOKUP-1',
      ),
    ).toBeNull();
  });

  it('rejects binding the same provider reference to a different operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const first = await store.createOperation({
      idempotencyKey: 'sub-a',
      idempotencyScope: scope,
      commandFingerprint: 'fp-a',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const planScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'billing_plan',
    });
    const second = await store.createOperation({
      idempotencyKey: 'sub-b',
      idempotencyScope: planScope,
      commandFingerprint: 'fp-b',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'billing_plan',
    });
    await store.transitionOperation({
      operationId: first.operationId,
      expectedVersion: 1,
      nextStatus: 'submitted',
      providerReferenceId: 'shared-ref',
      providerSubscriptionId: 'shared-ref',
      reason: 'seed first',
    });
    await expect(
      store.transitionOperation({
        operationId: second.operationId,
        expectedVersion: 1,
        nextStatus: 'submitted',
        providerReferenceId: 'shared-ref',
        providerPlanId: 'shared-ref',
        reason: 'conflict',
      }),
    ).rejects.toMatchObject({ code: 'TRANSITION_REJECTED' });
  });

  it('lists uncertain subscription operations for reconciliation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const subScope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'subscription',
    });
    const operation = await store.createOperation({
      idempotencyKey: 'sub-uncertain',
      idempotencyScope: subScope,
      commandFingerprint: 'fp-sub',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'subscription',
      providerSubscriptionId: 'SUB-UNCERTAIN-1',
    });
    await store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: 1,
      nextStatus: 'unknown',
      reason: 'provider timeout',
    });

    const uncertain = await store.listUncertainOperations(10);
    expect(uncertain.some((row) => row.operationId === operation.operationId)).toBe(true);
  });

  it('uses optimistic concurrency on transitions', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const operation = await store.createOperation({
      idempotencyKey: 'idem-2',
      idempotencyScope: scope,
      commandFingerprint: 'fp-1',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'checkout',
      providerReferenceId: 'order-1',
    });
    await store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: 1,
      nextStatus: 'submitted',
      reason: 'test',
    });
    await expect(
      store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: 1,
        nextStatus: 'succeeded',
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });
  });

  it('clears explicit null error fields and preserves omitted errors', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const evidence = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'evt-error-clear',
      rawPayload: '{}',
      payloadSha256: 'abc',
    });
    await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      errorCode: 'EDC_DISPATCH_FAILED',
      errorMessage: 'not eligible for dispatch',
    });

    const preserved = await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      processingStatus: 'unmatched',
    });
    expect(preserved.errorCode).toBe('EDC_DISPATCH_FAILED');
    expect(preserved.errorMessage).toBe('not eligible for dispatch');

    const cleared = await store.updateEvidence({
      evidenceId: evidence.evidenceId,
      processingStatus: 'processed',
      errorCode: null,
      errorMessage: null,
    });
    expect(cleared.processingStatus).toBe('processed');
    expect(cleared.errorCode).toBeNull();
    expect(cleared.errorMessage).toBeNull();
  });
});
