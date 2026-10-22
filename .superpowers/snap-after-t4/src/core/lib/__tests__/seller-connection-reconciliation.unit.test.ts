import { describe, expect, it, vi } from 'vitest';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { reconcileSellerConnectionAggregate } from '../seller-connection-reconciliation';

const baseConnection = {
  applicationRef: 'app-1',
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox' as const,
  sellerRef: 'seller-a',
  trackingId: 'seller-a',
};

describe('reconcileSellerConnectionAggregate', () => {
  it('resolves tracking id then refreshes merchant status without creating a referral', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const connection = await store.createSellerConnection(baseConnection);
    const findMerchantByTrackingId = vi.fn().mockResolvedValue({
      providerMerchantId: 'MERCHANT-1',
      trackingId: 'seller-a',
      matchCount: 1,
      ambiguous: false,
    });
    const getMerchantStatus = vi.fn().mockResolvedValue({
      providerMerchantId: 'MERCHANT-1',
      trackingId: 'seller-a',
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      grantedScopes: [
        'https://uri.paypal.com/services/payments/realtimepayment',
        'https://uri.paypal.com/services/payments/refund',
      ],
      productActive: true,
      hasLimitations: false,
      consentPresent: true,
    });

    const result = await reconcileSellerConnectionAggregate({
      store,
      providerLookup: { findMerchantByTrackingId, getMerchantStatus },
      connection,
    });

    expect(result.outcome).toBe('applied');
    expect(findMerchantByTrackingId).toHaveBeenCalledTimes(1);
    expect(getMerchantStatus).toHaveBeenCalledWith(
      expect.objectContaining({ providerMerchantId: 'MERCHANT-1' }),
    );
    expect(result.connection.providerMerchantId).toBe('MERCHANT-1');
    expect(result.connection.readinessReady).toBe(true);
  });

  it('returns ambiguous when tracking lookup matches more than one merchant', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const connection = await store.createSellerConnection(baseConnection);
    const result = await reconcileSellerConnectionAggregate({
      store,
      providerLookup: {
        findMerchantByTrackingId: vi.fn().mockResolvedValue({
          providerMerchantId: null,
          trackingId: 'seller-a',
          matchCount: 2,
          ambiguous: true,
        }),
        getMerchantStatus: vi.fn(),
      },
      connection,
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.connection.providerMerchantId).toBeNull();
  });

  it('preserves revoked consent during merchant status refresh', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const created = await store.createSellerConnection(baseConnection);
    await store.updateSellerConnection({
      connectionId: created.connectionId,
      expectedVersion: created.version,
      providerMerchantId: 'MERCHANT-1',
      consentStatus: 'revoked',
      connectionStatus: 'revoked',
      readinessReady: false,
      readinessReasons: ['seller consent was revoked'],
    });
    const latest = await store.findSellerConnectionBySellerRef(
      'app-1',
      'paypal',
      'default',
      'sandbox',
      'seller-a',
    );
    if (!latest) {
      throw new Error('expected seller connection');
    }
    const result = await reconcileSellerConnectionAggregate({
      store,
      providerLookup: {
        findMerchantByTrackingId: vi.fn(),
        getMerchantStatus: vi.fn().mockResolvedValue({
          providerMerchantId: 'MERCHANT-1',
          trackingId: 'seller-a',
          paymentsReceivable: true,
          primaryEmailConfirmed: true,
          grantedScopes: [
            'https://uri.paypal.com/services/payments/realtimepayment',
            'https://uri.paypal.com/services/payments/refund',
          ],
          productActive: true,
          hasLimitations: false,
          consentPresent: true,
        }),
      },
      connection: latest,
    });
    expect(result.connection.consentStatus).toBe('revoked');
    expect(result.connection.readinessReady).toBe(false);
  });
});
