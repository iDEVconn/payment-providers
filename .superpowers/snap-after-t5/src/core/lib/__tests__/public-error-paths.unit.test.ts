import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  toPaymentReliabilityErrorPayload,
} from '../../../contracts/index';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { PaymentRecoveryService } from '../payment-recovery-service';
import { resolveProviderFailure } from '../resolve-provider-failure';
import { WebhookProcessingService } from '../webhook-processing-service';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { PaypalWebhookVerifier } from '../../../paypal/lib/paypal-webhook-verifier';
import { resolvePaymentRuntime } from '../resolve-payment-runtime';

const SENSITIVE = {
  secret: 'fake-client-secret',
  token: 'fake-access-token',
  auth: 'Authorization: Bearer fake-token',
  postgres: 'postgres://internal-host',
  path: '/private/internal/payment.env',
  proxy: 'ECONNREFUSED internal-paypal-proxy',
};

function assertNoSensitiveLeak(value: unknown) {
  const text = JSON.stringify(value);
  for (const fragment of Object.values(SENSITIVE)) {
    expect(text).not.toContain(fragment);
  }
}

describe('public error path sanitization', () => {
  it('sanitizes PaymentReliabilityError construction and RPC payload', () => {
    const error = new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      `upstream failed ${SENSITIVE.secret} ${SENSITIVE.token}`,
    );
    assertNoSensitiveLeak(error);
    assertNoSensitiveLeak(toPaymentReliabilityErrorPayload(error));
    expect(error.code).toBe(PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN);
    expect(error.message).toBe('Payment reliability error');
  });

  it('sanitizes nested provider failures via resolveProviderFailure', () => {
    const resolved = resolveProviderFailure(
      new Error(`${SENSITIVE.proxy} ${SENSITIVE.path}`),
    );
    assertNoSensitiveLeak(resolved);
    expect(resolved.message).toBe('Provider submission failed');
  });

  it('maps webhook verification transport throw to unavailable without leaking', async () => {
    const runtime = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
    });
    const verifier = new PaypalWebhookVerifier(
      runtime,
      {
        verifyWebhookSignature: async () => {
          throw new Error(`${SENSITIVE.auth} ${SENSITIVE.postgres}`);
        },
      },
      'development',
    );
    const result = await verifier.verify({
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      webhookId: 'wh-1',
      rawBody: '{"event_type":"TEST","resource":{"id":"r1"}}',
      headers: {
        transmissionId: 'tx-1',
        transmissionTime: '2026-01-01T00:00:00Z',
        certUrl: 'https://example.test/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
      },
    });
    assertNoSensitiveLeak(result);
    expect(result.failureKind).toBe('verification_unavailable');
  });

  it('wraps webhook persistence failures without raw external messages', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    vi.spyOn(store, 'insertEvidence').mockRejectedValueOnce(
      new Error(`db ${SENSITIVE.postgres} ${SENSITIVE.secret}`),
    );
    try {
      await service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        rawBody: '{"event_type":"TEST"}',
        providerEventId: 'evt-1',
        verify: async () => ({
          verified: true,
          transmissionId: 'tx',
          eventType: 'TEST',
          resourceId: null,
        }),
      });
      throw new Error('expected persistence failure');
    } catch (error) {
      assertNoSensitiveLeak(error);
      expect(error).toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
      });
    }
  });

  it('sanitizes consumer delivery persistence for Error, string, and structured throws', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-sanitize',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'cap-sanitize',
      providerCaptureId: 'cap-sanitize',
      providerOrderId: 'ord-sanitize',
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-sanitize',
      rawPayload:
        '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-sanitize"}}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-sanitize',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'processed',
      consumerDeliveryStatus: 'pending',
    });

    const cases: Array<{ label: string; deliver: () => Promise<void> }> = [
      {
        label: 'Error',
        deliver: async () => {
          throw new Error(`consumer ${SENSITIVE.token}`);
        },
      },
      {
        label: 'string',
        deliver: async () => {
          throw SENSITIVE.path;
        },
      },
      {
        label: 'structured',
        deliver: async () => {
          throw { message: SENSITIVE.auth, code: 'DB_FAIL' };
        },
      },
    ];

    for (const testCase of cases) {
      const recovery = new PaymentRecoveryService({
        store,
        webhookProcessing,
        consumer: { deliver: testCase.deliver },
      });
      const summary = await recovery.recover({ workerId: `worker-${testCase.label}`, limit: 5 });
      expect(summary.failed).toBe(1);
      const updated = await store.findEvidenceById(inserted.evidenceId);
      assertNoSensitiveLeak(updated?.consumerDeliveryLastError);
      expect(updated?.consumerDeliveryLastError).toBe('Consumer event delivery failed');
      await store.updateEvidence({
        evidenceId: inserted.evidenceId,
        consumerDeliveryStatus: 'pending',
        consumerDeliveryLastError: null,
      });
    }
  });

  it('retries delivery after sanitized failure and confirms on success', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const webhookProcessing = new WebhookProcessingService(store);
    let attempts = 0;
    const recovery = new PaymentRecoveryService({
      store,
      webhookProcessing,
      consumer: {
        deliver: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error(SENSITIVE.secret);
          }
        },
      },
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: 'test-app',
      accountRef: 'default',
      environment: 'sandbox',
      kind: 'capture',
    });
    await store.createOperation({
      idempotencyKey: 'idem-retry',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      kind: 'capture',
      providerReferenceId: 'cap-retry',
      providerCaptureId: 'cap-retry',
      providerOrderId: 'ord-retry',
    });
    const inserted = await store.insertEvidence({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      evidenceKind: 'webhook',
      providerEventId: 'tx-retry',
      rawPayload:
        '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"cap-retry"}}',
      payloadSha256: 'sha',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'cap-retry',
    });
    await store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'processed',
      consumerDeliveryStatus: 'pending',
    });

    await recovery.recover({ workerId: 'worker-retry-1', limit: 5 });
    expect(attempts).toBe(1);
    const failedRow = await store.findEvidenceById(inserted.evidenceId);
    expect(failedRow?.consumerDeliveryLastError).toBe('Consumer event delivery failed');

    const summary = await recovery.recover({ workerId: 'worker-retry-2', limit: 5 });
    expect(summary.delivered).toBe(1);
    expect(attempts).toBe(2);
    const confirmed = await store.findEvidenceById(inserted.evidenceId);
    expect(confirmed?.consumerDeliveryStatus).toBe('confirmed');
  });
});
