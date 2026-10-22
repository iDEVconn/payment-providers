import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RETRY_STATUS,
  type ExecuteGetSubscriptionResult,
  type PaymentOperation,
} from '../../../contracts/index';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { ReconciliationService } from '../reconciliation-service';
import {
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from '../retry-backoff';
import { WebhookProcessingService } from '../webhook-processing-service';

/*
 * Issues #8 and #20: candidate selection for reconciliation, recovery and uncertain operations is
 * fair. Unsuccessful rows are deferred with exponential backoff and give up after a cap; recovery
 * never claims rows it can only skip. Ports probe p5 (30 foreign unmatched rows; 30 old
 * verification-unavailable rows plus one verified/pending row).
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

const T0 = Date.parse('2026-10-22T12:00:00.000Z');

function lookupOf(
  getSubscription: ReconciliationProviderLookup['getSubscription'],
): ReconciliationProviderLookup {
  return { getSubscription } as unknown as ReconciliationProviderLookup;
}

function activeSnapshot(id: string): ExecuteGetSubscriptionResult {
  return {
    providerSubscriptionId: id,
    providerPlanId: 'P-1',
    subscriptionStatus: 'active',
    approvalUrl: null,
    startTime: null,
    nextBillingTime: null,
    lifecycleReason: null,
  };
}

let eventSeq = 0;

function receive(
  webhooks: WebhookProcessingService,
  eventType: string,
  subscriptionId: string,
  verified = true,
  resource: Record<string, unknown> = {},
) {
  eventSeq += 1;
  return webhooks.receiveWebhook({
    ...ctx,
    rawBody: JSON.stringify({
      id: `WH-${eventSeq}`,
      event_type: eventType,
      resource: { id: subscriptionId, ...resource },
    }),
    verify: async () =>
      verified
        ? { verified: true, transmissionId: 't', eventType, resourceId: subscriptionId }
        : {
            verified: false,
            transmissionId: 't',
            eventType: null,
            resourceId: null,
            failureKind: 'verification_unavailable' as const,
            unavailableReason: 'outage',
          },
  });
}

async function seedSubmitted(
  store: MemoryPaymentReliabilityStore,
  subscriptionId: string,
): Promise<PaymentOperation> {
  const op = await store.createOperation({
    ...ctx,
    idempotencyKey: subscriptionId,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp',
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: subscriptionId,
    providerPlanId: 'P-1',
  });
  return store.transitionOperation({
    operationId: op.operationId,
    expectedVersion: op.version,
    nextStatus: 'submitted',
    providerReferenceId: subscriptionId,
    reason: 'seed',
  });
}

async function seedUnknown(
  store: MemoryPaymentReliabilityStore,
  subscriptionId: string,
): Promise<PaymentOperation> {
  const op = await store.createOperation({
    ...ctx,
    idempotencyKey: subscriptionId,
    idempotencyScope: buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    commandFingerprint: 'fp',
    kind: 'subscription',
    subscriptionStatus: 'approval_pending',
    providerSubscriptionId: subscriptionId,
    providerPlanId: 'P-1',
  });
  const claimed = await store.claimOperationForExecution({
    operationId: op.operationId,
    expectedVersion: op.version,
  });
  return store.transitionOperation({
    operationId: claimed.operationId,
    expectedVersion: claimed.version,
    nextStatus: 'unknown',
    subscriptionStatus: 'unknown',
    reason: 'timeout',
  });
}

function bySubscriptionId(store: MemoryPaymentReliabilityStore, id: string) {
  return store.findOperationByProviderSubscriptionId(
    ctx.providerCode,
    ctx.accountRef,
    ctx.environment,
    id,
  );
}

async function evidenceOf(store: MemoryPaymentReliabilityStore, evidenceId: string) {
  const row = await store.findEvidenceById(evidenceId);
  if (!row) {
    throw new Error(`missing evidence ${evidenceId}`);
  }
  return row;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reconcile() does not starve behind foreign unmatched rows (issue #8, probe p5)', () => {
  it('reconciles our event within one run of reconcile(25) behind 30 foreign rows', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const foreign: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      foreign.push((await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', `F${i}`)).evidenceId);
    }
    const mine = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'S7');
    expect(mine.processingStatus).toBe('unmatched');
    await seedSubmitted(store, 'S7');

    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async ({ providerSubscriptionId }) => activeSnapshot(providerSubscriptionId)),
    );
    await reconciliation.reconcile(25);

    expect((await bySubscriptionId(store, 'S7'))?.subscriptionStatus).toBe('active');
    expect((await evidenceOf(store, mine.evidenceId)).processingStatus).toBe('processed');
    // Every foreign row was attempted once and deferred, none of them gave up.
    for (const evidenceId of foreign) {
      const row = await evidenceOf(store, evidenceId);
      expect(row.attempts).toBe(1);
      expect(Date.parse(row.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());
      expect(row.retryStatus ?? null).toBe(null);
    }
  });

  it('a deferred row is not examined again before its nextAttemptAt; the delay doubles up to the max', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'F-ONLY');
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async () => {
        throw new Error('not called for unmatched rows');
      }),
      {},
      { retryBaseDelayMs: 1_000, retryMaxDelayMs: 3_000, maxAttempts: 10 },
    );

    expect((await reconciliation.reconcile(25)).examined).toBe(1);
    let stored = await evidenceOf(store, row.evidenceId);
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).toBe(new Date(T0 + 1_000).toISOString());

    expect((await reconciliation.reconcile(25)).examined).toBe(0);

    vi.setSystemTime(T0 + 1_000);
    expect((await reconciliation.reconcile(25)).examined).toBe(1);
    stored = await evidenceOf(store, row.evidenceId);
    expect(stored.attempts).toBe(2);
    expect(stored.nextAttemptAt).toBe(new Date(T0 + 1_000 + 2_000).toISOString());

    vi.setSystemTime(T0 + 3_000);
    await reconciliation.reconcile(25);
    stored = await evidenceOf(store, row.evidenceId);
    expect(stored.attempts).toBe(3);
    // 4000 ms would exceed retryMaxDelayMs.
    expect(stored.nextAttemptAt).toBe(new Date(T0 + 3_000 + 3_000).toISOString());
  });

  it('gives up after maxAttempts: retryStatus gave_up, processing status kept, never listed again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'F-GIVE-UP');
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async () => {
        throw new Error('not called');
      }),
      {},
      { retryBaseDelayMs: 10, retryMaxDelayMs: 10, maxAttempts: 2 },
    );

    await reconciliation.reconcile(25);
    vi.setSystemTime(T0 + 10);
    await reconciliation.reconcile(25);
    const stored = await evidenceOf(store, row.evidenceId);
    expect(stored.attempts).toBe(2);
    expect(stored.retryStatus).toBe(RETRY_STATUS.GAVE_UP);
    expect(stored.processingStatus).toBe('unmatched');

    vi.setSystemTime(T0 + 86_400_000);
    expect((await reconciliation.reconcile(25)).examined).toBe(0);
  });

  it('an uncertain operation whose lookup keeps failing is deferred, then gives up and stays unknown', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const stuck = await seedUnknown(store, 'I-STUCK');
    const lookup = vi.fn(async (): Promise<ExecuteGetSubscriptionResult> => {
      throw new Error('PayPal down');
    });
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(lookup),
      {},
      { retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000, maxAttempts: 2 },
    );

    expect((await reconciliation.reconcile(25)).retryableFailures).toBe(1);
    let operation = await store.findOperationById(stuck.operationId);
    expect(operation?.attempts).toBe(1);
    expect(operation?.nextAttemptAt).toBe(new Date(T0 + 1_000).toISOString());

    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 1_000);
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(2);
    operation = await store.findOperationById(stuck.operationId);
    expect(operation?.retryStatus).toBe(RETRY_STATUS.GAVE_UP);
    expect(operation?.status).toBe('unknown');

    vi.setSystemTime(T0 + 86_400_000);
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('a newer uncertain operation is reached while an older one waits for its backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    await seedUnknown(store, 'I-OLD');
    vi.setSystemTime(T0 + 5);
    const newer = await seedUnknown(store, 'I-NEW');
    const lookup = vi.fn(async ({ providerSubscriptionId }: { providerSubscriptionId: string }) => {
      if (providerSubscriptionId === 'I-OLD') {
        throw new Error('PayPal down');
      }
      return activeSnapshot(providerSubscriptionId);
    });
    const reconciliation = new ReconciliationService(store, lookupOf(lookup));

    await reconciliation.reconcile(1);
    expect(lookup).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'I-OLD' }),
    );
    await reconciliation.reconcile(1);
    expect(lookup).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerSubscriptionId: 'I-NEW' }),
    );
    expect((await store.findOperationById(newer.operationId))?.subscriptionStatus).toBe('active');
  });

  it('a plan-mismatch row stays unmatched by design and is bounded by the attempt cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-PLAN');
    await seedSubmitted(store, 'I-PLAN');
    const lookup = vi.fn(async () => ({ ...activeSnapshot('I-PLAN'), providerPlanId: 'P-OTHER' }));
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(lookup),
      {},
      { retryBaseDelayMs: 100, retryMaxDelayMs: 100, maxAttempts: 2 },
    );

    expect((await reconciliation.reconcile(25)).terminalFailures).toBe(1);
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 100);
    await reconciliation.reconcile(25);
    vi.setSystemTime(T0 + 86_400_000);
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await evidenceOf(store, row.evidenceId)).retryStatus).toBe(RETRY_STATUS.GAVE_UP);
    expect((await bySubscriptionId(store, 'I-PLAN'))?.subscriptionStatus).toBe('approval_pending');
  });
});

describe('recover() does not starve (issue #20, probe p5)', () => {
  it('processes the verified row in the first recover(25) behind 30 verification-unavailable rows', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    for (let i = 0; i < 30; i += 1) {
      await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', `U${i}`, false).catch(() => null);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedSubmitted(store, 'S9');
    // The first processing of our event fails on a store write: verified, still pending.
    const transition = store.transitionOperation.bind(store);
    let failOnce = true;
    store.transitionOperation = async (input) => {
      if (failOnce && input.reason.startsWith('Webhook')) {
        failOnce = false;
        throw new Error('db down');
      }
      return transition(input);
    };
    const mineEventId = `WH-${eventSeq + 1}`;
    await receive(webhooks, 'BILLING.SUBSCRIPTION.CANCELLED', 'S9').catch(() => null);
    const before = await store.findEvidenceByProviderEvent(
      'paypal',
      'default',
      'sandbox',
      mineEventId,
    );
    expect([before?.verificationStatus, before?.processingStatus]).toEqual(['verified', 'pending']);

    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });
    const first = await recovery.recover({ workerId: 'w', limit: 25 });

    expect(first.processed).toBe(1);
    expect(first.claimed).toBe(1);
    expect((await bySubscriptionId(store, 'S9'))?.subscriptionStatus).toBe('cancelled');
  });

  it('defers a row it could not process; a newer row is reached on the next run', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const foreign: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      foreign.push((await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', `F${i}`)).evidenceId);
    }
    vi.setSystemTime(T0 + 5);
    const mine = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'S-NEW');
    await seedSubmitted(store, 'S-NEW');
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });

    const first = await recovery.recover({ workerId: 'w', limit: 3 });
    expect(first).toMatchObject({ claimed: 3, skipped: 3, processed: 0 });
    for (const evidenceId of foreign) {
      expect((await evidenceOf(store, evidenceId)).attempts).toBe(1);
    }
    const second = await recovery.recover({ workerId: 'w', limit: 3 });
    expect(second).toMatchObject({ claimed: 1, processed: 1 });
    expect((await evidenceOf(store, mine.evidenceId)).processingStatus).toBe('processed');
  });

  it('a pending row (plan mismatch) is deferred with backoff and gives up after maxAttempts', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    await seedSubmitted(store, 'I-MISMATCH');
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-MISMATCH', true, {
      plan_id: 'P-OTHER',
    });
    expect(row.processingStatus).toBe('pending');
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
      maxAttempts: 2,
    });

    expect((await recovery.recover({ workerId: 'w' })).claimed).toBe(1);
    let stored = await evidenceOf(store, row.evidenceId);
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).toBe(new Date(T0 + 1_000).toISOString());
    expect((await recovery.recover({ workerId: 'w' })).claimed).toBe(0);

    vi.setSystemTime(T0 + 1_000);
    expect((await recovery.recover({ workerId: 'w' })).claimed).toBe(1);
    stored = await evidenceOf(store, row.evidenceId);
    expect(stored.retryStatus).toBe(RETRY_STATUS.GAVE_UP);
    expect(stored.processingStatus).toBe('pending');

    vi.setSystemTime(T0 + 86_400_000);
    expect((await recovery.recover({ workerId: 'w' })).claimed).toBe(0);
    // An explicit recovery does not revive a row that gave up: the host resets it first.
    expect(
      (
        await recovery.recoverEvidence({
          evidenceId: row.evidenceId,
          workerId: 'w',
          environment: 'sandbox',
        })
      ).claimed,
    ).toBe(0);
  });

  it('recoverEvidence ignores the backoff of the row it names', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'S-LATE');
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });
    expect((await recovery.recover({ workerId: 'w' })).skipped).toBe(1);
    await seedSubmitted(store, 'S-LATE');
    const explicit = await recovery.recoverEvidence({
      evidenceId: row.evidenceId,
      workerId: 'w',
      environment: 'sandbox',
    });
    expect(explicit.processed).toBe(1);
  });
});

describe('retry options are validated', () => {
  const store = new MemoryPaymentReliabilityStore();
  const lookup = lookupOf(async () => activeSnapshot('I-1'));

  it('exposes the defaults', () => {
    expect([
      DEFAULT_RETRY_BASE_DELAY_MS,
      DEFAULT_RETRY_MAX_DELAY_MS,
      DEFAULT_RETRY_MAX_ATTEMPTS,
    ]).toEqual([60_000, 3_600_000, 100]);
  });

  it.each([
    [{ retryBaseDelayMs: 0 }, 'retryBaseDelayMs'],
    [{ retryBaseDelayMs: -1 }, 'retryBaseDelayMs'],
    [{ retryBaseDelayMs: Number.NaN }, 'retryBaseDelayMs'],
    [{ retryBaseDelayMs: 1.5 }, 'retryBaseDelayMs'],
    [{ retryMaxDelayMs: Number.POSITIVE_INFINITY }, 'retryMaxDelayMs'],
    [{ retryBaseDelayMs: 2_000, retryMaxDelayMs: 1_000 }, 'retryMaxDelayMs'],
    [{ maxAttempts: 0 }, 'maxAttempts'],
    [{ maxAttempts: 2.5 }, 'maxAttempts'],
    [{ submittedStaleAfterMs: 0 }, 'submittedStaleAfterMs'],
  ])('ReconciliationService rejects %o', (options, field) => {
    let error: unknown;
    try {
      new ReconciliationService(store, lookup, {}, options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual([field]);
  });

  it.each([
    [{ retryBaseDelayMs: 0 }, 'retryBaseDelayMs'],
    [{ retryBaseDelayMs: 5_000, retryMaxDelayMs: 1_000 }, 'retryMaxDelayMs'],
    [{ maxAttempts: -3 }, 'maxAttempts'],
  ])('PaymentRecoveryService rejects %o', (options, field) => {
    let error: unknown;
    try {
      new PaymentRecoveryService({
        store,
        webhookProcessing: new WebhookProcessingService(store),
        consumer: null,
        ...options,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual([field]);
  });
});
