import { describe, expect, it, vi } from 'vitest';
import type { ReconciliationProviderLookup } from '../checkout-provider-port';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { ReconciliationService } from '../reconciliation-service';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app-1',
  environment: 'sandbox' as const,
};

describe('Marketplace reconciliation', () => {
  it('uses marketplace GET with full units instead of first-party checkout lookup', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const getMarketplaceOrder = vi.fn().mockResolvedValue({
      providerOrderId: 'order-mp-1',
      marketplaceStatus: 'partially_captured',
      approvalUrl: null,
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
    });
    const getOrder = vi.fn();
    const providerLookup: ReconciliationProviderLookup = {
      getOrder,
      getRefund: vi.fn(),
      getPayoutBatch: vi.fn(),
      getPayoutItem: vi.fn(),
      getProduct: vi.fn(),
      getPlan: vi.fn(),
      getSubscription: vi.fn(),
      getReferral: vi.fn(),
      findMerchantByTrackingId: vi.fn(),
      getMerchantStatus: vi.fn(),
      getMarketplaceOrder,
    };
    const service = new ReconciliationService(store, providerLookup);

    const scope = buildOperationIdempotencyScope({
      ...ctx,
      kind: 'marketplace_checkout',
    });
    const checkout = await store.createOperation({
      idempotencyKey: 'idem-mp-recon',
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
      nextStatus: 'unknown',
      providerOrderId: 'order-mp-1',
      providerReferenceId: 'order-mp-1',
      reason: 'seed uncertain checkout',
    });
    await store.insertMarketplacePurchaseUnits([
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

    const result = await service.reconcile(10);
    expect(result.applied).toBeGreaterThan(0);
    expect(getMarketplaceOrder).toHaveBeenCalledTimes(1);
    expect(getOrder).not.toHaveBeenCalled();
    const units = await store.listMarketplacePurchaseUnits(checkout.operationId);
    expect(units.find((unit) => unit.referenceId === 'unit-a')?.unitStatus).toBe('captured');
    expect(units.find((unit) => unit.referenceId === 'unit-b')?.unitStatus).toBe('declined');
  });
});
