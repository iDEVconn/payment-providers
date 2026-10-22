import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR } from '../../../contracts/index';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { buildOperationIdempotencyScope } from '../operation-idempotency';

describe('PaymentRecoveryService', () => {
  it('reprocesses verified pending evidence and delivers consumer', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    const deliver = vi.fn(async () => undefined);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing,
      consumer: { deliver },
    });

    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-recover',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'capture-recover',
      providerCaptureId: 'capture-recover',
      providerOrderId: 'order-recover',
    });

    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-recover',
      rawPayload: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-recover"}}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'capture-recover',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
    });

    const summary = await recovery.recover({
      workerId: 'worker-1',
      limit: 5,
    });

    expect(summary.processed).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const updated = await store.findEvidenceById(inserted.evidenceId);
    expect(updated?.processingStatus).toBe('processed');
    expect(updated?.consumerDeliveryStatus).toBe('confirmed');
  });

  it('recoverEvidence delegates to recover with a single evidence id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing,
      consumer: { deliver: vi.fn(async () => undefined) },
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-single',
      rawPayload: '{}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'missing',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
    });

    const result = await recovery.recoverEvidence({
      evidenceId: inserted.evidenceId,
      workerId: 'worker-single',
      environment: 'sandbox',
    });
    expect(result.evidenceId).toBe(inserted.evidenceId);
    expect(result.claimed).toBe(1);
  });

  it('delivers processed evidence without re-running financial reprocess when only delivery failed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    const reprocess = vi.spyOn(webhookProcessing, 'reprocessStoredWebhookEvidence');
    const deliver = vi.fn(async () => undefined);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing,
      consumer: { deliver },
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-deliver-only',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'cap-deliver-only',
      providerCaptureId: 'cap-deliver-only',
      providerOrderId: 'ord-deliver-only',
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-deliver-only',
      rawPayload:
        '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-deliver-only"}}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-deliver-only',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'processed',
      consumerDeliveryStatus: 'failed',
      consumerDeliveryAttempts: 1,
      consumerDeliveryLastError: 'down',
    });

    const summary = await recovery.recover({
      workerId: 'worker-deliver',
      limit: 5,
    });

    expect(summary.delivered).toBe(1);
    expect(reprocess).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('records failed consumer delivery and counts batch failure', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing,
      consumer: {
        deliver: vi.fn(async () => {
          throw new Error('consumer rejected');
        }),
      },
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-consumer-fail',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'cap-consumer-fail',
      providerCaptureId: 'cap-consumer-fail',
      providerOrderId: 'ord-consumer-fail',
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-consumer-fail',
      rawPayload:
        '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-consumer-fail"}}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-consumer-fail',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'processed',
      consumerDeliveryStatus: 'failed',
    });

    const summary = await recovery.recover({ workerId: 'worker-fail', limit: 5 });
    expect(summary.failed).toBe(1);
    const updated = await store.findEvidenceById(inserted.evidenceId);
    expect(updated?.consumerDeliveryStatus).toBe('failed');
    expect(updated?.consumerDeliveryLastError).toBe('Consumer event delivery failed');
  });

  // Recovery cannot verify without the transmission headers: it no longer claims such rows only to
  // skip them (issue #20; was claimed 1 / skipped 1).
  it('does not claim evidence still awaiting provider verification', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: new WebhookProcessingService(store),
      consumer: null,
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-pending-verify',
      rawPayload: '{}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-pending',
    });

    const summary = await recovery.recover({
      workerId: 'worker-pending',
      limit: 5,
      evidenceIds: [inserted.evidenceId],
    });
    expect(summary.claimed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('respects recovery batch limit', async () => {
    const store = new MemoryPaymentReliabilityStore();
    // Rows awaiting delivery are claimed only when a consumer is configured (issue #21).
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: new WebhookProcessingService(store),
      consumer: { deliver: vi.fn(async () => undefined) },
    });
    for (let i = 0; i < 3; i += 1) {
      const row = await store.insertEvidence({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        evidenceKind: 'webhook',
        providerEventId: `tx-limit-${i}`,
        rawPayload: '{}',
        payloadSha256: `sha-${i}`,
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: `cap-limit-${i}`,
      });
      await store.updateEvidence({
        evidenceId: row.evidenceId,
        verificationStatus: 'verified',
        processingStatus: 'processed',
        consumerDeliveryStatus: 'pending',
      });
    }

    const summary = await recovery.recover({ workerId: 'worker-limit', limit: 1 });
    expect(summary.claimed).toBe(1);
  });

  it('rejects recoverEvidence when environment does not match evidence', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing: new WebhookProcessingService(store),
      consumer: null,
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-env-mismatch',
      rawPayload: '{}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-env',
    });

    await expect(
      recovery.recoverEvidence({
        evidenceId: inserted.evidenceId,
        workerId: 'worker-env',
        environment: 'live',
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST });
  });
});
