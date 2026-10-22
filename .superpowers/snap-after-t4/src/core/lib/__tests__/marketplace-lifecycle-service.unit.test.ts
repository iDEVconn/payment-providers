import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import { MarketplaceLifecycleService } from '../marketplace-lifecycle-service';
import type { MarketplaceProviderPort } from '../marketplace-provider-port';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import type { SellerConnectionReconciliationLookup } from '../seller-connection-reconciliation';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app-1',
  environment: 'sandbox' as const,
};

function fakeProvider(overrides: Partial<MarketplaceProviderPort> = {}): MarketplaceProviderPort {
  return {
    createOrder: vi.fn().mockResolvedValue({
      providerOrderId: 'order-mp-1',
      marketplaceStatus: 'created',
      approvalUrl: 'https://sandbox.paypal.com/approve/order-mp-1',
      units: [
        {
          referenceId: 'unit-a',
          providerMerchantId: 'MERCHANT-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          platformFee: { currency: 'USD', amountMinor: '100' },
          unitStatus: 'pending',
          providerCaptureId: null,
          providerFee: null,
          netAmount: null,
        },
      ],
    }),
    getOrder: vi.fn(),
    captureOrder: vi.fn(),
    refundUnit: vi.fn(),
    getRefund: vi.fn(),
    ...overrides,
  };
}

function fakeSellerRecon(): SellerConnectionReconciliationLookup {
  return {
    findMerchantByTrackingId: vi.fn(),
    getMerchantStatus: vi.fn(),
  };
}

async function seedReadySeller(
  store: MemoryPaymentReliabilityStore,
  sellerRef = 'seller-a',
  merchantId = 'MERCHANT-1',
) {
  const connection = await store.createSellerConnection({
    applicationRef: ctx.applicationRef,
    providerCode: ctx.providerCode,
    accountRef: ctx.accountRef,
    environment: ctx.environment,
    sellerRef,
    trackingId: sellerRef,
  });
  await store.updateSellerConnection({
    connectionId: connection.connectionId,
    expectedVersion: connection.version,
    providerMerchantId: merchantId,
    connectionStatus: 'ready',
    consentStatus: 'granted',
    paymentsReceivable: true,
    primaryEmailConfirmed: true,
    requiredPermissionsGranted: true,
    onboardingCompleted: true,
    readinessReady: true,
    readinessReasons: [],
  });
  const evidence = await store.insertEvidence({
    ...ctx,
    evidenceKind: 'reconciliation',
    providerEventId: `recon-${sellerRef}`,
    rawPayload: '{}',
    payloadSha256: createHash('sha256').update('{}', 'utf8').digest('hex'),
    eventType: 'RECONCILIATION.PROVIDER_LOOKUP',
    resourceId: merchantId,
  });
  await store.updateEvidence({
    evidenceId: evidence.evidenceId,
    verificationStatus: 'verified',
    processingStatus: 'processed',
    processedAt: new Date().toISOString(),
  });
}

describe('MarketplaceLifecycleService', () => {
  it('creates a marketplace checkout with ready seller and unit rows', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedReadySeller(store);
    const provider = fakeProvider();
    const service = new MarketplaceLifecycleService(store, provider, fakeSellerRecon());

    const result = await service.createMarketplaceOrder({
      ...ctx,
      idempotencyKey: 'idem-mp-1',
      units: [
        {
          sellerRef: 'seller-a',
          referenceId: 'unit-a',
          amount: { currency: 'USD', amountMinor: '1000' },
          platformFee: { currency: 'USD', amountMinor: '100' },
        },
      ],
    });

    expect(result.providerOrderId).toBe('order-mp-1');
    expect(result.units).toHaveLength(1);
    expect(provider.createOrder).toHaveBeenCalledTimes(1);
    const operation = await store.findOperationByProviderOrderId(
      ctx.providerCode,
      ctx.accountRef,
      ctx.environment,
      'order-mp-1',
    );
    expect(operation?.kind).toBe('marketplace_checkout');
  });

  it('rejects more than ten purchase units', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedReadySeller(store);
    const service = new MarketplaceLifecycleService(store, fakeProvider(), fakeSellerRecon());
    await expect(
      service.createMarketplaceOrder({
        ...ctx,
        idempotencyKey: 'idem-mp-2',
        units: Array.from({ length: 11 }, (_, index) => ({
          sellerRef: 'seller-a',
          referenceId: `unit-${index}`,
          amount: { currency: 'USD', amountMinor: '100' },
        })),
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });

  it('rejects platform fee greater than or equal to unit amount', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedReadySeller(store);
    const service = new MarketplaceLifecycleService(store, fakeProvider(), fakeSellerRecon());
    await expect(
      service.createMarketplaceOrder({
        ...ctx,
        idempotencyKey: 'idem-mp-3',
        units: [
          {
            sellerRef: 'seller-a',
            referenceId: 'unit-a',
            amount: { currency: 'USD', amountMinor: '1000' },
            platformFee: { currency: 'USD', amountMinor: '1000' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });

  it('preserves captured sibling units on partial capture response', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedReadySeller(store, 'seller-a', 'MERCHANT-1');
    await seedReadySeller(store, 'seller-b', 'MERCHANT-2');
    const provider = fakeProvider({
      captureOrder: vi.fn().mockResolvedValue({
        providerOrderId: 'order-mp-1',
        marketplaceStatus: 'partially_captured',
        httpStatus: 207,
        units: [
          {
            referenceId: 'unit-a',
            providerMerchantId: 'MERCHANT-1',
            amount: { currency: 'USD', amountMinor: '1000' },
            platformFee: null,
            unitStatus: 'captured',
            providerCaptureId: 'capture-a',
            providerFee: null,
            netAmount: null,
          },
          {
            referenceId: 'unit-b',
            providerMerchantId: 'MERCHANT-2',
            amount: { currency: 'USD', amountMinor: '2000' },
            platformFee: null,
            unitStatus: 'declined',
            providerCaptureId: null,
            providerFee: null,
            netAmount: null,
          },
        ],
      }),
    });
    const service = new MarketplaceLifecycleService(store, provider, fakeSellerRecon());
    const created = await service.createMarketplaceOrder({
      ...ctx,
      idempotencyKey: 'idem-mp-4',
      units: [
        {
          sellerRef: 'seller-a',
          referenceId: 'unit-a',
          amount: { currency: 'USD', amountMinor: '1000' },
        },
        {
          sellerRef: 'seller-b',
          referenceId: 'unit-b',
          amount: { currency: 'USD', amountMinor: '2000' },
        },
      ],
    });
    const captured = await service.captureMarketplaceOrder({
      ...ctx,
      idempotencyKey: 'idem-cap-1',
      marketplaceOperationId: created.operationId,
      providerOrderId: 'order-mp-1',
    });

    expect(captured.marketplaceStatus).toBe('partially_captured');
    const units = await store.listMarketplacePurchaseUnits(created.operationId);
    expect(units.find((unit) => unit.referenceId === 'unit-a')?.unitStatus).toBe('captured');
    expect(units.find((unit) => unit.referenceId === 'unit-b')?.unitStatus).toBe('declined');
  });
});
