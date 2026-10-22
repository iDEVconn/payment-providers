import { describe, expect, it } from 'vitest';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { WebhookProcessingService } from '../webhook-processing-service';

describe('seller onboarding webhooks', () => {
  it('revokes consent from MERCHANT.PARTNER-CONSENT.REVOKED without marking ready', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createSellerConnection({
      applicationRef: 'app-1',
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
    });
    await store.updateSellerConnection({
      connectionId: created.connectionId,
      expectedVersion: created.version,
      providerMerchantId: 'MERCHANT-1',
    });
    const service = new WebhookProcessingService(store);
    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'app-1',
      environment: 'sandbox',
      providerEventId: 'evt-1',
      rawBody: JSON.stringify({
        event_type: 'MERCHANT.PARTNER-CONSENT.REVOKED',
        resource: { merchant_id: 'MERCHANT-1' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-1',
        eventType: 'MERCHANT.PARTNER-CONSENT.REVOKED',
        resourceId: 'MERCHANT-1',
      }),
    });
    expect(receipt.processingStatus).toBe('processed');
    const connection = await store.findSellerConnectionByMerchantId(
      'app-1',
      'paypal',
      'default',
      'sandbox',
      'MERCHANT-1',
    );
    expect(connection?.consentStatus).toBe('revoked');
    expect(connection?.connectionStatus).toBe('revoked');
    expect(connection?.readinessReady).toBe(false);
  });

  it('attaches merchant id from MERCHANT.ONBOARDING.COMPLETED without marking ready', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createSellerConnection({
      applicationRef: 'app-1',
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
    });
    const service = new WebhookProcessingService(store);
    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'app-1',
      environment: 'sandbox',
      providerEventId: 'evt-onboard',
      rawBody: JSON.stringify({
        event_type: 'MERCHANT.ONBOARDING.COMPLETED',
        resource: { merchant_id: 'MERCHANT-1', tracking_id: 'seller-a' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-onboard',
        eventType: 'MERCHANT.ONBOARDING.COMPLETED',
        resourceId: 'MERCHANT-1',
      }),
    });
    expect(receipt.processingStatus).toBe('processed');
    const connection = await store.findSellerConnectionById(created.connectionId);
    expect(connection?.providerMerchantId).toBe('MERCHANT-1');
    expect(connection?.readinessReady).toBe(false);
    expect(connection?.connectionStatus).not.toBe('active');
  });

  it('ignores out-of-order granted hints after consent was revoked', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createSellerConnection({
      applicationRef: 'app-1',
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'sandbox',
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
    });
    await store.updateSellerConnection({
      connectionId: created.connectionId,
      expectedVersion: created.version,
      providerMerchantId: 'MERCHANT-1',
      consentStatus: 'revoked',
      connectionStatus: 'revoked',
      readinessReady: false,
    });
    const service = new WebhookProcessingService(store);
    await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'app-1',
      environment: 'sandbox',
      providerEventId: 'evt-granted',
      rawBody: JSON.stringify({
        event_type: 'CUSTOMER.MERCHANT-INTEGRATION.SELLER-CONSENT-GRANTED',
        resource: { merchant_id: 'MERCHANT-1' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-granted',
        eventType: 'CUSTOMER.MERCHANT-INTEGRATION.SELLER-CONSENT-GRANTED',
        resourceId: 'MERCHANT-1',
      }),
    });
    const connection = await store.findSellerConnectionByMerchantId(
      'app-1',
      'paypal',
      'default',
      'sandbox',
      'MERCHANT-1',
    );
    expect(connection?.consentStatus).toBe('revoked');
  });

  it('does not invent or apply undocumented seller events', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const receipt = await service.receiveWebhook({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'app-1',
      environment: 'sandbox',
      providerEventId: 'evt-2',
      rawBody: JSON.stringify({
        event_type: 'MERCHANT.ONBOARDING.FAKE',
        resource: { merchant_id: 'MERCHANT-1' },
      }),
      verify: async () => ({
        verified: true,
        transmissionId: 'tx-2',
        eventType: 'MERCHANT.ONBOARDING.FAKE',
        resourceId: 'MERCHANT-1',
      }),
    });
    expect(receipt.processingStatus).toBe('unsupported');
  });
});
