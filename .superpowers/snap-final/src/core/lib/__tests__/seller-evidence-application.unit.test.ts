import { describe, expect, it } from 'vitest';
import type { SellerConnectionRecord } from '../../../contracts/index';
import { mapMerchantStatusToConnectionPatch } from '../seller-evidence-application';

const baseConnection: SellerConnectionRecord = {
  connectionId: 'conn-1',
  applicationRef: 'app-1',
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox',
  sellerRef: 'seller-a',
  trackingId: 'seller-a',
  latestReferralOperationId: null,
  providerReferralId: null,
  providerMerchantId: 'MERCHANT-1',
  connectionStatus: 'revoked',
  consentStatus: 'revoked',
  paymentsReceivable: false,
  primaryEmailConfirmed: true,
  requiredPermissionsGranted: false,
  onboardingCompleted: false,
  restricted: true,
  readinessReady: false,
  readinessReasons: ['seller consent was revoked'],
  normalizedCapabilities: {},
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('mapMerchantStatusToConnectionPatch', () => {
  it('does not clear revoked consent when status GET reports consentPresent true', () => {
    const patch = mapMerchantStatusToConnectionPatch(
      {
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
      },
      baseConnection,
    );
    expect(patch.consentStatus).toBe('revoked');
    expect(patch.readinessReady).toBe(false);
    expect(patch.connectionStatus).toBe('revoked');
  });

  it('maps missing consent to missing rather than revoked', () => {
    const patch = mapMerchantStatusToConnectionPatch(
      {
        providerMerchantId: 'MERCHANT-1',
        trackingId: 'seller-a',
        paymentsReceivable: false,
        primaryEmailConfirmed: false,
        grantedScopes: [],
        productActive: false,
        hasLimitations: true,
        consentPresent: false,
      },
      { ...baseConnection, consentStatus: 'unknown', connectionStatus: 'onboarding_pending' },
    );
    expect(patch.consentStatus).toBe('missing');
    expect(patch.connectionStatus).not.toBe('revoked');
  });
});
