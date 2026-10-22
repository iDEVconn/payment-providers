import { describe, expect, it } from 'vitest';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';
import { buildOperationIdempotencyScope } from '../operation-idempotency';

describe('WebhookProcessingService incomplete duplicate resume', () => {
  it('does not ack duplicate when processed but consumer delivery is not confirmed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-dup-resume',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'cap-dup',
      providerCaptureId: 'cap-dup',
      providerOrderId: 'ord-dup',
    });

    const first = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-dup"}}',
      providerEventId: 'tx-dup-resume',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-dup-resume',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'cap-dup',
      }),
    });
    expect(first.processingStatus).toBe('processed');

    await store.updateEvidence({
      evidenceId: first.evidenceId,
      consumerDeliveryStatus: 'failed',
      consumerDeliveryAttempts: 1,
      consumerDeliveryLastError: 'consumer down',
    });

    const second = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-dup"}}',
      providerEventId: 'tx-dup-resume',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-dup-resume',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'cap-dup',
      }),
    });

    expect(second.duplicate).toBe(false);
    expect(second.processingStatus).toBe('processed');
    const ops = await store.findOperationByProviderCaptureId(
      'paypal',
      'default',
      'sandbox',
      'cap-dup',
    );
    expect(ops?.status).toBe('succeeded');
  });
});
