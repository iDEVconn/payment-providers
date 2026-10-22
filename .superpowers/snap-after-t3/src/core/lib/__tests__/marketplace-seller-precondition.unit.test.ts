import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR } from '../../../contracts/index';
import { ensureSellerReadyForMarketplace } from '../marketplace-seller-precondition';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import type { SellerConnectionReconciliationLookup } from '../seller-connection-reconciliation';

const ctx = {
  applicationRef: 'app-1',
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox' as const,
  sellerRef: 'seller-a',
};

function validMerchantStatus() {
  return {
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
  };
}

async function seedConnection(
  store: MemoryPaymentReliabilityStore,
  overrides: { restricted?: boolean; readinessReady?: boolean; providerMerchantId?: string } = {},
) {
  const connection = await store.createSellerConnection({
    ...ctx,
    trackingId: ctx.sellerRef,
  });
  return store.updateSellerConnection({
    connectionId: connection.connectionId,
    expectedVersion: connection.version,
    providerMerchantId: overrides.providerMerchantId ?? 'MERCHANT-1',
    connectionStatus: 'ready',
    consentStatus: 'granted',
    paymentsReceivable: true,
    primaryEmailConfirmed: true,
    requiredPermissionsGranted: true,
    onboardingCompleted: true,
    readinessReady: overrides.readinessReady ?? true,
    readinessReasons: [],
    restricted: overrides.restricted ?? false,
  });
}

async function seedFreshEvidence(store: MemoryPaymentReliabilityStore, resourceId: string) {
  const evidence = await store.insertEvidence({
    ...ctx,
    evidenceKind: 'reconciliation',
    providerEventId: `recon-${resourceId}-${Math.random()}`,
    rawPayload: '{}',
    payloadSha256: createHash('sha256').update('{}', 'utf8').digest('hex'),
    eventType: 'RECONCILIATION.PROVIDER_LOOKUP',
    resourceId,
  });
  await store.updateEvidence({
    evidenceId: evidence.evidenceId,
    verificationStatus: 'verified',
    processingStatus: 'processed',
    processedAt: new Date().toISOString(),
  });
}

describe('ensureSellerReadyForMarketplace', () => {
  it('uses read-only seller recon lookups and never createReferral', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedConnection(store);
    const sellerRecon: SellerConnectionReconciliationLookup = {
      findMerchantByTrackingId: vi.fn(),
      getMerchantStatus: vi.fn().mockResolvedValue(validMerchantStatus()),
    };
    const now = vi.fn().mockReturnValue(Date.parse('2026-09-26T12:00:00.000Z'));

    await ensureSellerReadyForMarketplace({
      store,
      sellerRecon,
      ...ctx,
      now,
      maxAgeMs: 60_000,
    });

    expect(sellerRecon.getMerchantStatus).toHaveBeenCalledTimes(1);
    expect(sellerRecon.findMerchantByTrackingId).not.toHaveBeenCalled();
    expect(sellerRecon).not.toHaveProperty('createReferral');
  });

  it('reconciles when evidence is older than maxAgeMs', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const connection = await seedConnection(store);
    await seedFreshEvidence(store, connection.providerMerchantId ?? 'MERCHANT-1');
    const sellerRecon: SellerConnectionReconciliationLookup = {
      findMerchantByTrackingId: vi.fn(),
      getMerchantStatus: vi.fn().mockResolvedValue(validMerchantStatus()),
    };

    await ensureSellerReadyForMarketplace({
      store,
      sellerRecon,
      ...ctx,
      now: () => Date.now(),
      maxAgeMs: -1,
    });

    expect(sellerRecon.getMerchantStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects restricted sellers before provider calls when fresh', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await seedConnection(store, { restricted: true });
    const sellerRecon: SellerConnectionReconciliationLookup = {
      findMerchantByTrackingId: vi.fn(),
      getMerchantStatus: vi.fn(),
    };

    await expect(
      ensureSellerReadyForMarketplace({
        store,
        sellerRecon,
        ...ctx,
        now: () => Date.parse('2026-09-26T12:00:00.000Z'),
        maxAgeMs: 900_000,
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
    });
    expect(sellerRecon.getMerchantStatus).not.toHaveBeenCalled();
  });
});
