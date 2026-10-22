import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import {
  DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS,
  PaymentRecoveryService,
} from '../payment-recovery-service';
import type { VerifiedProcessedPaymentEvent } from '../payment-event-consumer';
import { DEFAULT_RETRY_MAX_DELAY_MS } from '../retry-backoff';
import { WebhookProcessingService } from '../webhook-processing-service';

/*
 * Issues #21 and #24: consumer delivery through `PaymentRecoveryService`. Ports probes p5b
 * (no consumer configured) and p7 (failing consumer, failing acknowledgement write).
 */

const scope = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

async function seedProcessedEvents(
  store: MemoryPaymentReliabilityStore,
  webhooks: WebhookProcessingService,
  count: number,
): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const subscriptionId = `S-${i}`;
    const op = await store.createOperation({
      ...scope,
      idempotencyKey: subscriptionId,
      idempotencyScope: buildOperationIdempotencyScope({
        ...scope,
        kind: 'subscription',
      }),
      commandFingerprint: 'fp',
      kind: 'subscription',
      subscriptionStatus: 'approval_pending',
      providerSubscriptionId: subscriptionId,
      providerPlanId: 'P-1',
    });
    await store.transitionOperation({
      operationId: op.operationId,
      expectedVersion: op.version,
      nextStatus: 'submitted',
      providerReferenceId: subscriptionId,
      reason: 'seed',
    });
    const eventId = `WH-${i}`;
    const receipt = await webhooks.receiveWebhook({
      ...scope,
      rawBody: JSON.stringify({
        id: eventId,
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: subscriptionId },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 't',
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: subscriptionId,
      }),
    });
    expect(receipt.processingStatus).toBe('processed');
    eventIds.push(eventId);
  }
  return eventIds;
}

/** A failed delivery waits for its backoff (issue #20): move the clock past it between runs. */
function passRetryBackoff(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + DEFAULT_RETRY_MAX_DELAY_MS);
}

afterEach(() => {
  vi.useRealTimers();
});

async function evidenceFor(store: MemoryPaymentReliabilityStore, eventId: string) {
  const row = await store.findEvidenceByProviderEvent('paypal', 'default', 'sandbox', eventId);
  if (!row) {
    throw new Error(`missing evidence ${eventId}`);
  }
  return row;
}

describe('recover() without a consumer (issue #21)', () => {
  it('claims no rows for delivery and reports delivered 0 on every run (probe p5b)', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const eventIds = await seedProcessedEvents(store, webhooks, 30);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });

    for (let run = 0; run < 3; run += 1) {
      const summary = await recovery.recover({ workerId: 'w', limit: 25 });
      expect(summary).toEqual({
        claimed: 0,
        verified: 0,
        processed: 0,
        delivered: 0,
        skipped: 0,
        failed: 0,
      });
    }
    for (const eventId of eventIds) {
      const row = await evidenceFor(store, eventId);
      expect(row.consumerDeliveryStatus).toBe('pending');
      expect(row.claimWorkerId).toBeNull();
    }
  });

  it('counts rows a store returns anyway as skipped, never as delivered, and releases them', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const eventIds = await seedProcessedEvents(store, webhooks, 3);
    const claim = store.claimPendingEvidence.bind(store);
    // A host store that ignores `includeConsumerDelivery`.
    store.claimPendingEvidence = (input) => claim({ ...input, includeConsumerDelivery: undefined });
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });

    const summary = await recovery.recover({ workerId: 'w', limit: 25 });
    expect(summary).toMatchObject({
      claimed: 3,
      delivered: 0,
      skipped: 3,
      failed: 0,
    });
    for (const eventId of eventIds) {
      const row = await evidenceFor(store, eventId);
      expect(row.consumerDeliveryStatus).toBe('pending');
      expect(row.claimLeaseExpiresAt).toBeNull();
    }
  });

  it('still processes verified pending evidence without a consumer', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const inserted = await store.insertEvidence({
      ...scope,
      evidenceKind: 'webhook',
      providerEventId: 'WH-PENDING',
      rawPayload: '{"event_type":"SOMETHING.ELSE","resource":{"id":"x"}}',
      payloadSha256: 'sha',
      eventType: 'SOMETHING.ELSE',
      resourceId: 'x',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
    });
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: null,
    });
    const summary = await recovery.recover({ workerId: 'w' });
    expect(summary).toMatchObject({ claimed: 1, delivered: 0, skipped: 1 });
    expect((await store.findEvidenceById(inserted.evidenceId))?.processingStatus).toBe(
      'unsupported',
    );
  });
});

describe('consumer delivery attempts (issue #24)', () => {
  it('defaults the attempt cap to 10', () => {
    expect(DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS).toBe(10);
  });

  it('stops after maxConsumerDeliveryAttempts with a terminal failed_terminal status (probe p7)', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const [eventId] = await seedProcessedEvents(store, webhooks, 1);
    const deliver = vi.fn(async () => {
      throw new Error('entitlement db down');
    });
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
      maxConsumerDeliveryAttempts: 3,
    });

    const runs = [];
    for (let run = 0; run < 5; run += 1) {
      runs.push(await recovery.recover({ workerId: 'w' }));
      passRetryBackoff();
    }
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(runs.map((summary) => summary.failed)).toEqual([1, 1, 1, 0, 0]);
    expect(runs.map((summary) => summary.claimed)).toEqual([1, 1, 1, 0, 0]);
    const row = await evidenceFor(store, eventId!);
    expect(row.consumerDeliveryStatus).toBe('failed_terminal');
    expect(row.consumerDeliveryAttempts).toBe(3);
    expect(row.consumerDeliveryLastError).toBe('Consumer event delivery failed');

    // A redelivered webhook for a terminal row is acknowledged as a duplicate.
    const again = await webhooks.receiveWebhook({
      ...scope,
      rawBody: JSON.stringify({
        id: eventId,
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: 'S-0' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 't',
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: 'S-0',
      }),
    });
    expect(again.duplicate).toBe(true);
  });

  it('uses the default cap of 10 attempts', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const [eventId] = await seedProcessedEvents(store, webhooks, 1);
    const deliver = vi.fn(async () => {
      throw new Error('down');
    });
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    });
    for (let run = 0; run < 12; run += 1) {
      await recovery.recover({ workerId: 'w' });
      passRetryBackoff();
    }
    expect(deliver).toHaveBeenCalledTimes(10);
    expect((await evidenceFor(store, eventId!)).consumerDeliveryStatus).toBe('failed_terminal');
  });

  it('marks a row terminal without delivering when it already reached the cap', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const [eventId] = await seedProcessedEvents(store, webhooks, 1);
    const row = await evidenceFor(store, eventId!);
    await store.updateEvidence({
      evidenceId: row.evidenceId,
      consumerDeliveryStatus: 'failed',
      consumerDeliveryAttempts: 4,
    });
    const deliver = vi.fn(async () => undefined);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
      maxConsumerDeliveryAttempts: 4,
    });
    const summary = await recovery.recover({ workerId: 'w' });
    expect(summary).toMatchObject({ claimed: 1, delivered: 0, skipped: 1 });
    expect(deliver).not.toHaveBeenCalled();
    expect((await evidenceFor(store, eventId!)).consumerDeliveryStatus).toBe('failed_terminal');
  });

  it('rejects an invalid attempt cap', () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new PaymentRecoveryService({
            store,
            webhookProcessing: webhooks,
            consumer: null,
            maxConsumerDeliveryAttempts: value,
          }),
      ).toThrow(/maxConsumerDeliveryAttempts/);
    }
  });

  it('delivers at least once: a failed acknowledgement write causes one more delivery', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const [eventId] = await seedProcessedEvents(store, webhooks, 1);
    const deliver = vi.fn(async () => undefined);
    const update = store.updateEvidence.bind(store);
    let failOnce = true;
    store.updateEvidence = async (input) => {
      if (failOnce && input.consumerDeliveryStatus === 'confirmed') {
        failOnce = false;
        throw new Error('db blip');
      }
      return update(input);
    };
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver },
    });
    const first = await recovery.recover({ workerId: 'w' });
    passRetryBackoff();
    const second = await recovery.recover({ workerId: 'w' });
    expect(first).toMatchObject({ delivered: 0, failed: 1 });
    expect(second).toMatchObject({ delivered: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await evidenceFor(store, eventId!)).consumerDeliveryStatus).toBe('confirmed');
  });
});

describe('the consumer receives a narrowed event (issue #24)', () => {
  const narrowedKeys = [
    'accountRef',
    'applicationRef',
    'environment',
    'eventType',
    'evidenceId',
    'processingStatus',
    'providerCode',
    'providerEventId',
    'relatedOperationId',
    'resourceId',
    'verificationStatus',
  ];

  it('omits rawPayload and other row internals by default', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    const [eventId] = await seedProcessedEvents(store, webhooks, 1);
    const received: VerifiedProcessedPaymentEvent[] = [];
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver: async (event) => void received.push(event) },
    });
    expect(await recovery.recover({ workerId: 'w' })).toMatchObject({
      delivered: 1,
    });
    expect(Object.keys(received[0]!).sort()).toEqual(narrowedKeys);
    expect(received[0]!.providerEventId).toBe(eventId);
    expect(received[0]!.verificationStatus).toBe('verified');
  });

  it('includes rawPayload only when the host asks for it', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhooks = new WebhookProcessingService(store);
    await seedProcessedEvents(store, webhooks, 1);
    const received: VerifiedProcessedPaymentEvent[] = [];
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: webhooks,
      consumer: { deliver: async (event) => void received.push(event) },
      includeRawPayload: true,
    });
    await recovery.recover({ workerId: 'w' });
    expect(Object.keys(received[0]!).sort()).toEqual([...narrowedKeys, 'rawPayload'].sort());
    expect(JSON.parse(received[0]!.rawPayload!).event_type).toBe('BILLING.SUBSCRIPTION.ACTIVATED');
  });
});
