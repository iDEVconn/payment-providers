import { describe, expect, it } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app-1',
  environment: 'sandbox' as const,
};

describe('Marketplace webhook processing', () => {
  it('updates one purchase unit without marking the whole cart succeeded', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      ...ctx,
      kind: 'marketplace_checkout',
    });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-webhook',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      ...ctx,
      kind: 'marketplace_checkout',
      providerOrderId: 'order-mp-1',
      providerReferenceId: 'order-mp-1',
    });
    await store.transitionOperation({
      operationId: checkout.operationId,
      expectedVersion: checkout.version,
      nextStatus: 'submitted',
      providerOrderId: 'order-mp-1',
      providerReferenceId: 'order-mp-1',
      reason: 'seed submitted checkout',
    });
    const units = await store.insertMarketplacePurchaseUnits([
      {
        operationId: checkout.operationId,
        referenceId: 'unit-a',
        sellerRef: 'seller-a',
        providerMerchantId: 'MERCHANT-1',
        amountMinor: '1000',
        currencyCode: 'USD',
        unitStatus: 'pending',
      },
      {
        operationId: checkout.operationId,
        referenceId: 'unit-b',
        sellerRef: 'seller-b',
        providerMerchantId: 'MERCHANT-2',
        amountMinor: '2000',
        currencyCode: 'USD',
        unitStatus: 'pending',
      },
    ]);
    await store.updateMarketplacePurchaseUnit({
      unitId: units[0]!.unitId,
      expectedVersion: 1,
      providerCaptureId: 'capture-a',
    });

    const receipt = await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-a"}}',
      providerEventId: 'tx-mp-1',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-1',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'capture-a',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    const updatedUnits = await store.listMarketplacePurchaseUnits(checkout.operationId);
    expect(updatedUnits.find((unit) => unit.referenceId === 'unit-a')?.unitStatus).toBe('captured');
    expect(updatedUnits.find((unit) => unit.referenceId === 'unit-b')?.unitStatus).toBe('pending');
    const refreshedCheckout = await store.findOperationById(checkout.operationId);
    expect(refreshedCheckout?.status).not.toBe('succeeded');
  });

  it('records approval without fulfillment for marketplace checkout', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({
      ...ctx,
      kind: 'marketplace_checkout',
    });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-approved',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      ...ctx,
      kind: 'marketplace_checkout',
      providerOrderId: 'order-mp-2',
      providerReferenceId: 'order-mp-2',
    });
    await store.transitionOperation({
      operationId: checkout.operationId,
      expectedVersion: checkout.version,
      nextStatus: 'submitted',
      providerOrderId: 'order-mp-2',
      providerReferenceId: 'order-mp-2',
      reason: 'seed submitted checkout',
    });

    const receipt = await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"CHECKOUT.ORDER.APPROVED","resource":{"id":"order-mp-2"}}',
      providerEventId: 'tx-mp-2',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-2',
        eventType: 'CHECKOUT.ORDER.APPROVED',
        resourceId: 'order-mp-2',
      }),
    });

    expect(receipt.processingStatus).toBe('processed');
    const refreshed = await store.findOperationById(checkout.operationId);
    expect(refreshed?.status).toBe('submitted');
  });

  it('maps pending capture webhooks to unknown unit status', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({ ...ctx, kind: 'marketplace_checkout' });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-pending',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      ...ctx,
      kind: 'marketplace_checkout',
      providerOrderId: 'order-mp-3',
      providerReferenceId: 'order-mp-3',
    });
    const [unit] = await store.insertMarketplacePurchaseUnits([
      {
        operationId: checkout.operationId,
        referenceId: 'unit-a',
        sellerRef: 'seller-a',
        providerMerchantId: 'MERCHANT-1',
        amountMinor: '1000',
        currencyCode: 'USD',
        unitStatus: 'pending',
      },
    ]);
    await store.updateMarketplacePurchaseUnit({
      unitId: unit!.unitId,
      expectedVersion: 1,
      providerCaptureId: 'capture-pending',
    });

    await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"PAYMENT.CAPTURE.PENDING","resource":{"id":"capture-pending"}}',
      providerEventId: 'tx-mp-pending',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-pending',
        eventType: 'PAYMENT.CAPTURE.PENDING',
        resourceId: 'capture-pending',
      }),
    });

    const updated = await store.listMarketplacePurchaseUnits(checkout.operationId);
    expect(updated[0]?.unitStatus).toBe('unknown');
  });

  it('maps denied capture webhooks to declined unit status', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({ ...ctx, kind: 'marketplace_checkout' });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-denied',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      ...ctx,
      kind: 'marketplace_checkout',
      providerOrderId: 'order-mp-4',
      providerReferenceId: 'order-mp-4',
    });
    const [unit] = await store.insertMarketplacePurchaseUnits([
      {
        operationId: checkout.operationId,
        referenceId: 'unit-a',
        sellerRef: 'seller-a',
        providerMerchantId: 'MERCHANT-1',
        amountMinor: '1000',
        currencyCode: 'USD',
        unitStatus: 'pending',
      },
    ]);
    await store.updateMarketplacePurchaseUnit({
      unitId: unit!.unitId,
      expectedVersion: 1,
      providerCaptureId: 'capture-denied',
    });

    await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"PAYMENT.CAPTURE.DENIED","resource":{"id":"capture-denied"}}',
      providerEventId: 'tx-mp-denied',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-denied',
        eventType: 'PAYMENT.CAPTURE.DENIED',
        resourceId: 'capture-denied',
      }),
    });

    const updated = await store.listMarketplacePurchaseUnits(checkout.operationId);
    expect(updated[0]?.unitStatus).toBe('declined');
  });

  it('preserves captured units when duplicate or regressive capture events arrive', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const scope = buildOperationIdempotencyScope({ ...ctx, kind: 'marketplace_checkout' });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-dup',
      idempotencyScope: scope,
      commandFingerprint: 'fp',
      ...ctx,
      kind: 'marketplace_checkout',
      providerOrderId: 'order-mp-5',
      providerReferenceId: 'order-mp-5',
    });
    const [unit] = await store.insertMarketplacePurchaseUnits([
      {
        operationId: checkout.operationId,
        referenceId: 'unit-a',
        sellerRef: 'seller-a',
        providerMerchantId: 'MERCHANT-1',
        amountMinor: '1000',
        currencyCode: 'USD',
        unitStatus: 'captured',
      },
    ]);
    await store.updateMarketplacePurchaseUnit({
      unitId: unit!.unitId,
      expectedVersion: 1,
      providerCaptureId: 'capture-a',
    });

    await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"capture-a"}}',
      providerEventId: 'tx-mp-dup-1',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-dup-1',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: 'capture-a',
      }),
    });
    await service.receiveWebhook({
      ...ctx,
      rawBody: '{"event_type":"PAYMENT.CAPTURE.DENIED","resource":{"id":"capture-a"}}',
      providerEventId: 'tx-mp-dup-2',
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-mp-dup-2',
        eventType: 'PAYMENT.CAPTURE.DENIED',
        resourceId: 'capture-a',
      }),
    });

    const updated = await store.listMarketplacePurchaseUnits(checkout.operationId);
    expect(updated[0]?.unitStatus).toBe('captured');
  });
});
