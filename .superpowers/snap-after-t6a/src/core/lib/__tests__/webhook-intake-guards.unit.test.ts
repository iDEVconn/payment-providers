import { describe, expect, it, vi } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
};

const NOW = new Date('2026-10-22T12:00:00.000Z');

const headers = {
  transmissionId: 'tx-1',
  transmissionTime: '2026-10-22T11:59:00Z',
  certUrl: 'https://api.paypal.com/cert',
  authAlgo: 'SHA256withRSA',
  transmissionSig: 'sig',
};

function body(id: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...(id === null ? {} : { id }),
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'cap-1' },
    ...extra,
  });
}

function verified() {
  return vi.fn(async () => ({
    verified: true,
    transmissionId: 'tx-1',
    eventType: 'PAYMENT.CAPTURE.COMPLETED',
    resourceId: 'cap-1',
  }));
}

function setup(options?: ConstructorParameters<typeof WebhookProcessingService>[2]) {
  const store = new MemoryPaymentReliabilityStore();
  const insertEvidence = vi.spyOn(store, 'insertEvidence');
  const service = new WebhookProcessingService(store, undefined, { now: () => NOW, ...options });
  return { store, insertEvidence, service };
}

async function expectIntakeRejection(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PaymentReliabilityError);
  expect((error as PaymentReliabilityError).code).toBe('INVALID_REQUEST');
  expect((error as PaymentReliabilityError).message).toMatch(pattern);
}

describe('WebhookProcessingService intake guards (#15)', () => {
  it('rejects missing transmission headers before inserting evidence', async () => {
    const { service, insertEvidence } = setup();
    for (const missing of Object.keys(headers)) {
      const verify = verified();
      await expectIntakeRejection(
        service.receiveWebhook({
          ...ctx,
          rawBody: body('WH-1'),
          providerEventId: 'WH-1',
          headers: { ...headers, [missing]: '  ' },
          verify,
        }),
        /header/i,
      );
      expect(verify).not.toHaveBeenCalled();
    }
    expect(insertEvidence).not.toHaveBeenCalled();
  });

  it('requires headers when requireTransmissionHeaders is set', async () => {
    const { service, insertEvidence } = setup({ requireTransmissionHeaders: true });
    await expectIntakeRejection(
      service.receiveWebhook({ ...ctx, rawBody: body('WH-1'), verify: verified() }),
      /header/i,
    );
    expect(insertEvidence).not.toHaveBeenCalled();
  });

  it('rejects a body larger than the default 256 KiB cap', async () => {
    const { service, insertEvidence } = setup();
    const raw = body('WH-1', { padding: 'x'.repeat(262_144) });
    await expectIntakeRejection(
      service.receiveWebhook({ ...ctx, rawBody: raw, headers, verify: verified() }),
      /too large/i,
    );
    expect(insertEvidence).not.toHaveBeenCalled();
  });

  it('counts the cap in UTF-8 bytes and honours a configured maxBodyBytes', async () => {
    const { service, insertEvidence } = setup({ maxBodyBytes: 200 });
    const raw = body('WH-1', { note: 'é'.repeat(60) });
    expect(raw.length).toBeLessThanOrEqual(200);
    await expectIntakeRejection(
      service.receiveWebhook({ ...ctx, rawBody: raw, headers, verify: verified() }),
      /too large/i,
    );
    expect(insertEvidence).not.toHaveBeenCalled();

    const small = body('WH-2');
    const receipt = await service.receiveWebhook({
      ...ctx,
      rawBody: small,
      headers,
      verify: verified(),
    });
    expect(receipt.duplicate).toBe(false);
  });

  it('does not check transmission freshness by default', async () => {
    const { service, insertEvidence } = setup();
    await service.receiveWebhook({
      ...ctx,
      rawBody: body('WH-OLD'),
      headers: { ...headers, transmissionTime: '2026-10-19T00:00:00Z' },
      verify: verified(),
    });
    expect(insertEvidence).toHaveBeenCalledTimes(1);
  });

  it('rejects a new event older than maxTransmissionAgeMs or too far in the future', async () => {
    const { service, insertEvidence } = setup({ maxTransmissionAgeMs: 72 * 3_600_000 });
    for (const transmissionTime of ['2026-10-19T11:59:59Z', '2026-10-22T12:05:01Z', 'not-a-date']) {
      await expectIntakeRejection(
        service.receiveWebhook({
          ...ctx,
          rawBody: body('WH-1'),
          headers: { ...headers, transmissionTime },
          verify: verified(),
        }),
        /transmission/i,
      );
    }
    expect(insertEvidence).not.toHaveBeenCalled();

    for (const [id, transmissionTime] of [
      ['WH-2', '2026-10-19T12:00:01Z'],
      ['WH-3', '2026-10-22T12:04:59Z'],
    ]) {
      await service.receiveWebhook({
        ...ctx,
        rawBody: body(id),
        headers: { ...headers, transmissionTime },
        verify: verified(),
      });
    }
    expect(insertEvidence).toHaveBeenCalledTimes(2);
  });

  it('honours maxTransmissionFutureMs when the age check is enabled', async () => {
    const { service } = setup({ maxTransmissionAgeMs: 3_600_000, maxTransmissionFutureMs: 1_000 });
    await expectIntakeRejection(
      service.receiveWebhook({
        ...ctx,
        rawBody: body('WH-1'),
        headers: { ...headers, transmissionTime: '2026-10-22T12:00:02Z' },
        verify: verified(),
      }),
      /transmission/i,
    );
  });

  it('ignores maxTransmissionFutureMs alone (the age option turns the check on)', async () => {
    const { service, insertEvidence } = setup({ maxTransmissionFutureMs: 1_000 });
    await service.receiveWebhook({
      ...ctx,
      rawBody: body('WH-1'),
      headers: { ...headers, transmissionTime: '2026-10-22T13:00:00Z' },
      verify: verified(),
    });
    expect(insertEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps maxTransmissionSkewMs as a deprecated alias for both directions', async () => {
    const { service, insertEvidence } = setup({ maxTransmissionSkewMs: 30_000 });
    for (const transmissionTime of ['2026-10-22T11:59:00Z', '2026-10-22T12:01:00Z']) {
      await expectIntakeRejection(
        service.receiveWebhook({
          ...ctx,
          rawBody: body('WH-1'),
          headers: { ...headers, transmissionTime },
          verify: verified(),
        }),
        /transmission/i,
      );
    }
    await service.receiveWebhook({
      ...ctx,
      rawBody: body('WH-2'),
      headers: { ...headers, transmissionTime: '2026-10-22T11:59:45Z' },
      verify: verified(),
    });
    expect(insertEvidence).toHaveBeenCalledTimes(1);
  });

  it('processes a redelivery of a stored pending event that keeps its original old transmissionTime', async () => {
    let now = new Date('2026-10-22T10:00:00.000Z');
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store, undefined, {
      maxTransmissionAgeMs: 900_000,
      now: () => now,
    });
    const original = { ...headers, transmissionTime: '2026-10-22T10:00:00Z' };
    const raw = body('WH-RETRY');
    let available = false;
    const verify = async () =>
      available
        ? {
            verified: true,
            transmissionId: 'tx-1',
            eventType: 'PAYMENT.CAPTURE.COMPLETED',
            resourceId: 'cap-1',
          }
        : {
            verified: false,
            transmissionId: 'tx-1',
            eventType: null,
            resourceId: null,
            failureKind: 'verification_unavailable' as const,
            unavailableReason: 'outage',
          };

    await expect(
      service.receiveWebhook({ ...ctx, rawBody: raw, headers: original, verify }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
    expect(
      await store.findEvidenceByProviderEvent('paypal', 'default', 'sandbox', 'WH-RETRY'),
    ).toMatchObject({ verificationStatus: 'pending', processingStatus: 'pending' });

    available = true;
    now = new Date('2026-10-22T10:20:00.000Z');
    await service.receiveWebhook({ ...ctx, rawBody: raw, headers: original, verify });
    expect(
      await store.findEvidenceByProviderEvent('paypal', 'default', 'sandbox', 'WH-RETRY'),
    ).toMatchObject({ verificationStatus: 'verified' });
  });

  it('rejects invalid intake options when the service is built', () => {
    const store = new MemoryPaymentReliabilityStore();
    const invalid: Array<ConstructorParameters<typeof WebhookProcessingService>[2]> = [
      { maxBodyBytes: Number.NaN },
      { maxBodyBytes: 0 },
      { maxBodyBytes: -1 },
      { maxBodyBytes: Number.POSITIVE_INFINITY },
      { maxBodyBytes: 1.5 },
      { maxTransmissionAgeMs: Number.NaN },
      { maxTransmissionAgeMs: 0 },
      { maxTransmissionAgeMs: -5 },
      { maxTransmissionFutureMs: Number.NaN },
      { maxTransmissionFutureMs: 0 },
      { maxTransmissionSkewMs: -1 },
      { maxTransmissionSkewMs: Number.POSITIVE_INFINITY },
    ];
    for (const options of invalid) {
      expect(() => new WebhookProcessingService(store, undefined, options)).toThrow(
        PaymentConfigurationError,
      );
    }
    expect(
      () =>
        new WebhookProcessingService(store, undefined, {
          maxBodyBytes: 1024,
          maxTransmissionAgeMs: null,
          maxTransmissionSkewMs: null,
          maxTransmissionFutureMs: 1,
        }),
    ).not.toThrow();
  });

  it('derives providerEventId from the body id when the host does not pass one', async () => {
    const { service, store } = setup();
    await service.receiveWebhook({
      ...ctx,
      rawBody: body('WH-DERIVED'),
      headers,
      verify: verified(),
    });
    const evidence = await store.findEvidenceByProviderEvent(
      'paypal',
      'default',
      'sandbox',
      'WH-DERIVED',
    );
    expect(evidence?.providerEventId).toBe('WH-DERIVED');
  });

  it('rejects a host providerEventId that differs from the body id (replay under a new id)', async () => {
    const { service, insertEvidence } = setup();
    await expectIntakeRejection(
      service.receiveWebhook({
        ...ctx,
        rawBody: body('WH-ORIGINAL'),
        providerEventId: 'WH-REPLAYED',
        headers,
        verify: verified(),
      }),
      /does not match/i,
    );
    expect(insertEvidence).not.toHaveBeenCalled();
  });

  it('rejects a body without an id when the host passes no providerEventId', async () => {
    const { service, insertEvidence } = setup();
    for (const raw of [body(null), 'not json', '[]']) {
      await expectIntakeRejection(
        service.receiveWebhook({ ...ctx, rawBody: raw, headers, verify: verified() }),
        /event id/i,
      );
    }
    expect(insertEvidence).not.toHaveBeenCalled();
  });

  it('keeps accepting a host providerEventId when the body has no id', async () => {
    const { service, store } = setup();
    await service.receiveWebhook({
      ...ctx,
      rawBody: body(null),
      providerEventId: 'host-id',
      verify: verified(),
    });
    expect(
      await store.findEvidenceByProviderEvent('paypal', 'default', 'sandbox', 'host-id'),
    ).not.toBeNull();
  });

  it('does not echo the body or header values in intake errors', async () => {
    const { service } = setup();
    const error = (await service
      .receiveWebhook({
        ...ctx,
        rawBody: body('WH-SECRET-ID'),
        providerEventId: 'HOST-SECRET-ID',
        headers: { ...headers, transmissionSig: 'SIG-SECRET' },
        verify: verified(),
      })
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain('SECRET');
  });
});
