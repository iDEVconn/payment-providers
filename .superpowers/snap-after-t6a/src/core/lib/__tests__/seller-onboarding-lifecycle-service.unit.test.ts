import { describe, expect, it } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import { SellerOnboardingLifecycleService } from '../seller-onboarding-lifecycle-service';
import type { SellerOnboardingProviderPort } from '../seller-onboarding-provider-port';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app-1',
  environment: 'sandbox' as const,
};

function fakeProvider(
  overrides: Partial<SellerOnboardingProviderPort> = {},
): SellerOnboardingProviderPort {
  return {
    createReferral: async () => ({
      providerReferralId: 'REF-1',
      actionUrl: 'https://paypal.example/action',
      providerDebugId: 'dbg',
    }),
    getReferral: async () => ({
      providerReferralId: 'REF-1',
      actionUrl: 'https://paypal.example/action-refresh',
      providerDebugId: 'dbg',
    }),
    findMerchantByTrackingId: async () => ({
      providerMerchantId: 'MERCHANT-1',
      trackingId: 'seller-a',
    }),
    getMerchantStatus: async () => ({
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
    ...overrides,
  };
}

describe('SellerOnboardingLifecycleService', () => {
  it('creates one referral operation and one connection aggregate', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SellerOnboardingLifecycleService(store, fakeProvider());
    const created = await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    expect(created.providerReferralId).toBe('REF-1');
    expect(created.actionUrl).toBe('https://paypal.example/action');
    expect(created.connectionStatus).toBe('referral_created');

    const again = await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    expect(again.referralOperationId).toBe(created.referralOperationId);
    expect(again.connectionId).toBe(created.connectionId);
  });

  it('rejects a conflicting idempotency fingerprint', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SellerOnboardingLifecycleService(store, fakeProvider());
    await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    await expect(
      service.createSellerReferral({
        ...ctx,
        idempotencyKey: 'idemp-1',
        sellerRef: 'seller-b',
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });

  it('does not mark a connection active from the action URL', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SellerOnboardingLifecycleService(store, fakeProvider());
    const created = await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    const referral = await service.getSellerReferral({
      ...ctx,
      referralOperationId: created.referralOperationId,
    });
    expect(referral.actionUrl).toContain('action');
    const connection = await service.getSellerConnection({
      ...ctx,
      sellerRef: 'seller-a',
    });
    expect(connection.readiness.ready).toBe(false);
    expect(connection.connectionStatus).not.toBe('active');
  });

  it('reconciles readiness from merchant status GET only', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SellerOnboardingLifecycleService(store, fakeProvider());
    await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    const reconciled = await service.reconcileSellerConnection({
      ...ctx,
      sellerRef: 'seller-a',
    });
    expect(reconciled.providerMerchantId).toBe('MERCHANT-1');
    expect(reconciled.readiness.ready).toBe(true);
    expect(reconciled.connectionStatus).toBe('active');
  });

  it('keeps a merchant-id connection restricted when payments are not receivable', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new SellerOnboardingLifecycleService(
      store,
      fakeProvider({
        getMerchantStatus: async () => ({
          providerMerchantId: 'MERCHANT-1',
          trackingId: 'seller-a',
          paymentsReceivable: false,
          primaryEmailConfirmed: true,
          grantedScopes: [
            'https://uri.paypal.com/services/payments/realtimepayment',
            'https://uri.paypal.com/services/payments/refund',
          ],
          productActive: true,
          hasLimitations: false,
          consentPresent: true,
        }),
      }),
    );
    await service.createSellerReferral({
      ...ctx,
      idempotencyKey: 'idemp-1',
      sellerRef: 'seller-a',
    });
    const reconciled = await service.reconcileSellerConnection({
      ...ctx,
      sellerRef: 'seller-a',
    });
    expect(reconciled.providerMerchantId).toBe('MERCHANT-1');
    expect(reconciled.readiness.ready).toBe(false);
    expect(reconciled.connectionStatus).toBe('restricted');
  });

  it('rejects attaching one merchant id to two seller refs', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const first = await store.createSellerConnection({
      ...ctx,
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
    });
    await store.updateSellerConnection({
      connectionId: first.connectionId,
      expectedVersion: first.version,
      providerMerchantId: 'MERCHANT-1',
    });
    const second = await store.createSellerConnection({
      ...ctx,
      sellerRef: 'seller-b',
      trackingId: 'seller-b',
    });
    await expect(
      store.updateSellerConnection({
        connectionId: second.connectionId,
        expectedVersion: second.version,
        providerMerchantId: 'MERCHANT-1',
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });
});
