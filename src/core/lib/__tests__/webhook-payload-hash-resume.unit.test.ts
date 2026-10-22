import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../../contracts/index';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import {
  WebhookEventPayloadMismatchError,
  WebhookProcessingService,
} from '../webhook-processing-service';

/* T3 review finding 7: a stored event id is resumed only with the body it was stored with. */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

const original = JSON.stringify({
  id: 'WH-HASH',
  event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
  resource: { id: 'I-HASH' },
});

const tampered = JSON.stringify({
  id: 'WH-HASH',
  event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
  resource: { id: 'I-HASH' },
});

function unavailable() {
  return vi.fn(async () => ({
    verified: false,
    transmissionId: 't',
    failureKind: 'verification_unavailable' as const,
    unavailableReason: 'PayPal verify endpoint unavailable',
  }));
}

describe('receiveWebhook resume compares the payload hash', () => {
  it('rejects a different body under a stored event id before any processing', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    await expect(
      service.receiveWebhook({ ...ctx, rawBody: original, verify: unavailable() }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE });
    const stored = await store.findEvidenceByProviderEvent(
      ctx.providerCode,
      ctx.accountRef,
      ctx.environment,
      'WH-HASH',
    );
    const updateSpy = vi.spyOn(store, 'updateEvidence');
    const verify = vi.fn();

    const rejection = await service
      .receiveWebhook({ ...ctx, rawBody: tampered, verify })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WebhookEventPayloadMismatchError);
    expect(rejection).toBeInstanceOf(PaymentReliabilityError);
    expect((rejection as PaymentReliabilityError).code).toBe(
      PAYMENT_RELIABILITY_ERROR.WEBHOOK_PAYLOAD_MISMATCH,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    const after = await store.findEvidenceById(stored!.evidenceId);
    expect(after?.rawPayload).toBe(original);
    expect(after?.payloadSha256).toBe(stored?.payloadSha256);
  });

  it('rejects a different body even when the stored event was already processed', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const verified = async () => ({
      verified: true,
      transmissionId: 't',
      eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
      resourceId: 'I-HASH',
    });
    await service.receiveWebhook({ ...ctx, rawBody: original, verify: verified });

    await expect(
      service.receiveWebhook({ ...ctx, rawBody: tampered, verify: verified }),
    ).rejects.toBeInstanceOf(WebhookEventPayloadMismatchError);
  });

  it('resumes the stored event when the same body is redelivered', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    await expect(
      service.receiveWebhook({ ...ctx, rawBody: original, verify: unavailable() }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE });

    const receipt = await service.receiveWebhook({
      ...ctx,
      rawBody: original,
      verify: async () => ({
        verified: true,
        transmissionId: 't',
        eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
        resourceId: 'I-HASH',
      }),
    });

    expect(receipt.verificationStatus).toBe('verified');
    expect(receipt.processingStatus).toBe('unmatched');
  });
});
