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
  DEFAULT_RETRY_MAX_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  nextRetryDeferral,
  resolveRetryBackoffPolicy,
  retryDelayMs,
} from '../retry-backoff';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';
import { WebhookProcessingService } from '../webhook-processing-service';

/*
 * T6b review fix wave: `gave_up` must not lose real events (P1/P2), backoff math never throws at
 * run time, retry columns are cleared when a row resolves, and the budget/backoff cases that
 * mutation testing showed unpinned.
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const HOUR = 3_600_000;

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

function receive(webhooks: WebhookProcessingService, eventType: string, subscriptionId: string) {
  eventSeq += 1;
  return webhooks.receiveWebhook({
    ...ctx,
    rawBody: JSON.stringify({
      id: `WH-FW-${eventSeq}`,
      event_type: eventType,
      resource: { id: subscriptionId },
    }),
    verify: async () => ({
      verified: true,
      transmissionId: 't',
      eventType,
      resourceId: subscriptionId,
    }),
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
    providerReferenceId: subscriptionId,
    reason: 'timeout',
  });
}

async function evidenceOf(store: MemoryPaymentReliabilityStore, evidenceId: string) {
  const row = await store.findEvidenceById(evidenceId);
  if (!row) {
    throw new Error(`missing evidence ${evidenceId}`);
  }
  return row;
}

function bySubscriptionId(store: MemoryPaymentReliabilityStore, id: string) {
  return store.findOperationByProviderSubscriptionId(
    ctx.providerCode,
    ctx.accountRef,
    ctx.environment,
    id,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('gave_up does not lose real events (review finding 1, P1/P2)', () => {
  it('the default schedule outlasts PayPal redelivery (~3 days) with margin: gives up after about 94 h', () => {
    const policy = resolveRetryBackoffPolicy({}, 'test');
    expect(DEFAULT_RETRY_MAX_ATTEMPTS).toBe(100);
    let attempts = 0;
    let at = 0;
    for (;;) {
      const deferral = nextRetryDeferral(attempts, policy, at);
      attempts = deferral.attempts ?? 0;
      if (deferral.retryStatus) {
        break;
      }
      at = Date.parse(deferral.nextAttemptAt ?? '');
    }
    expect(attempts).toBe(100);
    // 1+2+4+8+16+32 min, then 93 x 60 min: 5643 min = 94.05 h after the first failure.
    expect(at).toBe(5_643 * 60_000);
    expect(at).toBeGreaterThan(90 * HOUR);
  });

  it('an unmatched event is processed when its operation appears after 25 h of hourly runs (P2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-LATE');
    expect(row.processingStatus).toBe('unmatched');
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async ({ providerSubscriptionId }) => activeSnapshot(providerSubscriptionId)),
    );
    for (let hour = 0; hour < 25; hour += 1) {
      await reconciliation.reconcile(25);
      vi.setSystemTime(Date.now() + HOUR + 1);
    }
    const waiting = await evidenceOf(store, row.evidenceId);
    // The old cap (20) would have given up here.
    expect(waiting.attempts).toBeGreaterThan(20);
    expect(waiting.retryStatus ?? null).toBe(null);

    await seedSubmitted(store, 'I-LATE');
    vi.setSystemTime(Date.now() + HOUR + 1);
    await reconciliation.reconcile(25);
    expect((await bySubscriptionId(store, 'I-LATE'))?.subscriptionStatus).toBe('active');
    const processed = await evidenceOf(store, row.evidenceId);
    expect(processed.processingStatus).toBe('processed');
    expect([processed.attempts ?? null, processed.nextAttemptAt ?? null]).toEqual([null, null]);
  });

  it('binding the subscription id on create revives an unmatched row that already gave up', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-REVIVE');
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async ({ providerSubscriptionId }) => activeSnapshot(providerSubscriptionId)),
      {},
      { retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000, maxAttempts: 2 },
    );
    await reconciliation.reconcile(25);
    vi.setSystemTime(T0 + 1_000);
    await reconciliation.reconcile(25);
    expect((await evidenceOf(store, row.evidenceId)).retryStatus).toBe(RETRY_STATUS.GAVE_UP);

    const lifecycle = new SubscriptionLifecycleService(store, {
      getPlan: async () => ({
        providerPlanId: 'P-1',
        providerProductId: 'PROD-1',
        planStatus: 'active' as const,
      }),
      createSubscription: async () => ({
        providerSubscriptionId: 'I-REVIVE',
        providerPlanId: 'P-1',
        subscriptionStatus: 'approval_pending' as const,
        approvalUrl: 'https://paypal.test/approve/I-REVIVE',
        startTime: null,
        nextBillingTime: null,
      }),
    } as unknown as SubscriptionProviderPort);
    await lifecycle.createSubscription({
      ...ctx,
      idempotencyKey: 'late-create',
      providerPlanId: 'P-1',
      offeringRef: 'pro',
      subscriber: { subscriberRef: 'u1' },
    });
    const revived = await evidenceOf(store, row.evidenceId);
    expect([
      revived.attempts ?? null,
      revived.nextAttemptAt ?? null,
      revived.retryStatus ?? null,
    ]).toEqual([null, null, null]);

    await reconciliation.reconcile(25);
    expect((await bySubscriptionId(store, 'I-REVIVE'))?.subscriptionStatus).toBe('active');
    expect((await evidenceOf(store, row.evidenceId)).processingStatus).toBe('processed');
  });
});

describe('budget and backoff pinned (review finding 3)', () => {
  it('reconcile(limit) makes at most limit PayPal lookups for evidence', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    for (let i = 0; i < 8; i += 1) {
      await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', `I-M${i}`);
    }
    for (let i = 0; i < 8; i += 1) {
      await seedSubmitted(store, `I-M${i}`);
    }
    const lookup = vi.fn(async ({ providerSubscriptionId }: { providerSubscriptionId: string }) =>
      activeSnapshot(providerSubscriptionId),
    );
    await new ReconciliationService(store, lookupOf(lookup)).reconcile(3);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('reconcile(limit) examines at most 10 x limit rows that correlate to nothing', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    for (let i = 0; i < 25; i += 1) {
      await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', `F-SCAN-${i}`);
    }
    const result = await new ReconciliationService(
      store,
      lookupOf(async () => {
        throw new Error('not called');
      }),
    ).reconcile(2);
    expect(result.examined).toBe(20);
  });

  it('evidence whose operation is still unknown is deferred with the operation', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedUnknown(store, 'I-STILL');
    const inserted = await store.insertEvidence({
      ...ctx,
      evidenceKind: 'webhook',
      providerEventId: 'WH-STILL',
      rawPayload: JSON.stringify({
        id: 'WH-STILL',
        event_type: 'BILLING.SUBSCRIPTION.UPDATED',
        resource: { id: 'I-STILL' },
      }),
      payloadSha256: 'sha',
      eventType: 'BILLING.SUBSCRIPTION.UPDATED',
      resourceId: 'I-STILL',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'processed',
      relatedOperationId: operation.operationId,
    });
    const lookup = vi.fn(async (): Promise<ExecuteGetSubscriptionResult> => {
      throw new Error('PayPal down');
    });
    const reconciliation = new ReconciliationService(store, lookupOf(lookup));
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await evidenceOf(store, inserted.evidenceId)).attempts).toBe(1);
    await reconciliation.reconcile(25);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a failed consumer delivery is not claimed again before its nextAttemptAt', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    await seedSubmitted(store, 'I-DELIVER');
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-DELIVER');
    expect(row.processingStatus).toBe('processed');
    const deliver = vi.fn(async () => {
      throw new Error('consumer down');
    });
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    });
    expect((await recovery.recover({ workerId: 'w' })).failed).toBe(1);
    const failed = await evidenceOf(store, row.evidenceId);
    expect(failed.consumerDeliveryStatus).toBe('failed');
    expect(Date.parse(failed.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());
    expect((await recovery.recover({ workerId: 'w' })).claimed).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a row processed by recovery keeps no retry state, so its delivery is not delayed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const row = await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-LATER');
    const deliver = vi.fn(async () => undefined);
    const withoutConsumer = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });
    await withoutConsumer.recover({ workerId: 'w' });
    expect((await evidenceOf(store, row.evidenceId)).attempts).toBe(1);
    await seedSubmitted(store, 'I-LATER');
    await withoutConsumer.recoverEvidence({
      evidenceId: row.evidenceId,
      workerId: 'w',
      environment: 'sandbox',
    });
    const processed = await evidenceOf(store, row.evidenceId);
    expect(processed.processingStatus).toBe('processed');
    expect([processed.attempts ?? null, processed.nextAttemptAt ?? null]).toEqual([null, null]);
    const withConsumer = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    });
    expect((await withConsumer.recover({ workerId: 'w' })).delivered).toBe(1);
  });
});

describe('backoff math never throws at run time (review finding 4)', () => {
  const policy = resolveRetryBackoffPolicy({}, 'test');

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -3, '5' as unknown as number])(
    'nextRetryDeferral treats attempts %p as 0',
    (previous) => {
      expect(nextRetryDeferral(previous, policy, 0)).toEqual({
        attempts: 1,
        nextAttemptAt: new Date(60_000).toISOString(),
        retryStatus: null,
      });
    },
  );

  it('retryDelayMs stays finite for any attempts', () => {
    expect(retryDelayMs(Number.NaN, policy)).toBe(60_000);
    expect(retryDelayMs(1e9, policy)).toBe(3_600_000);
    const handBuilt = {
      retryBaseDelayMs: 60_000,
      retryMaxDelayMs: Number.MAX_SAFE_INTEGER,
      maxAttempts: 100,
    };
    expect(() => nextRetryDeferral(50, handBuilt, 0)).not.toThrow();
  });

  it.each([
    [{ retryMaxDelayMs: MAX_RETRY_DELAY_MS + 1 }, 'retryMaxDelayMs'],
    [{ retryMaxDelayMs: Number.MAX_SAFE_INTEGER }, 'retryMaxDelayMs'],
    [{ retryBaseDelayMs: MAX_RETRY_DELAY_MS + 1 }, 'retryBaseDelayMs'],
    [{ maxAttempts: 1_000_001 }, 'maxAttempts'],
  ])('rejects %o at construction', (options, field) => {
    let error: unknown;
    try {
      new ReconciliationService(
        new MemoryPaymentReliabilityStore(),
        lookupOf(vi.fn()),
        {},
        options,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual([field]);
  });

  it('accepts a 7-day maximum delay', () => {
    expect(MAX_RETRY_DELAY_MS).toBe(604_800_000);
    const max = resolveRetryBackoffPolicy({ retryMaxDelayMs: MAX_RETRY_DELAY_MS }, 'test');
    expect(() => nextRetryDeferral(60, max, 0)).not.toThrow();
  });
});

describe('retry columns are cleared when a row resolves (review finding 6)', () => {
  it('a gave_up row processed by a PayPal redelivery has no retry state left', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const rawBody = JSON.stringify({
      id: 'WH-REDELIVER',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-REDELIVER' },
    });
    const verify = async () => ({
      verified: true,
      transmissionId: 't',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: 'I-REDELIVER',
    });
    const first = await webhooks.receiveWebhook({ ...ctx, rawBody, verify });
    await store.updateEvidence({
      evidenceId: first.evidenceId,
      attempts: 100,
      nextAttemptAt: null,
      retryStatus: RETRY_STATUS.GAVE_UP,
    });
    await seedSubmitted(store, 'I-REDELIVER');
    const again = await webhooks.receiveWebhook({ ...ctx, rawBody, verify });
    expect(again.processingStatus).toBe('processed');
    const row = await evidenceOf(store, first.evidenceId);
    expect([row.attempts ?? null, row.nextAttemptAt ?? null, row.retryStatus ?? null]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('an uncertain operation resolved by reconciliation has no retry state left', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedUnknown(store, 'I-RESOLVE');
    let down = true;
    const reconciliation = new ReconciliationService(
      store,
      lookupOf(async ({ providerSubscriptionId }) => {
        if (down) {
          throw new Error('PayPal down');
        }
        return activeSnapshot(providerSubscriptionId);
      }),
    );
    await reconciliation.reconcile(25);
    expect((await store.findOperationById(operation.operationId))?.attempts).toBe(1);
    down = false;
    vi.setSystemTime(T0 + HOUR);
    await reconciliation.reconcile(25);
    const resolved = await store.findOperationById(operation.operationId);
    expect(resolved?.status).not.toBe('unknown');
    expect([
      resolved?.attempts ?? null,
      resolved?.nextAttemptAt ?? null,
      resolved?.retryStatus ?? null,
    ]).toEqual([null, null, null]);
  });

  it('a stale create answered later by its retry has no retry state left', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const store = new MemoryPaymentReliabilityStore();
    const operation = await seedUnknown(store, 'I-ANSWERED');
    await store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      attempts: 3,
      nextAttemptAt: new Date(T0 + HOUR).toISOString(),
    });
    const webhooks = new WebhookProcessingService(store);
    await receive(webhooks, 'BILLING.SUBSCRIPTION.ACTIVATED', 'I-ANSWERED');
    const resolved = await store.findOperationById(operation.operationId);
    expect(resolved?.subscriptionStatus).toBe('active');
    expect([resolved?.attempts ?? null, resolved?.nextAttemptAt ?? null]).toEqual([null, null]);
  });
});
