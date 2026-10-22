import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CAPABILITIES,
  PaymentCapabilityError,
  type PaymentOperationKind,
  type SellerConnectionResult,
  type SellerReferralResult,
} from '../../index';

describe('payment-contracts', () => {
  it('lists the ten stable capability identifiers', () => {
    expect(PAYMENT_CAPABILITIES).toHaveLength(10);
    expect(PAYMENT_CAPABILITIES).toContain('checkout');
    expect(PAYMENT_CAPABILITIES).toContain('invoicing');
    expect(PAYMENT_CAPABILITIES).toContain('seller_onboarding');
  });

  it('exposes CAPABILITY_UNAVAILABLE errors without secrets', () => {
    const error = new PaymentCapabilityError('payout', 'Capability is disabled by configuration');
    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.capability).toBe('payout');
    expect(error.message).toContain('disabled by configuration');
  });

  it('includes seller_referral as the only seller mutation kind', () => {
    const kind: PaymentOperationKind = 'seller_referral';
    expect(kind).toBe('seller_referral');
  });

  it('keeps seller public DTOs free of secrets and readiness from action URL', () => {
    const referral: SellerReferralResult = {
      referralOperationId: 'op-1',
      connectionId: 'conn-1',
      operationStatus: 'succeeded',
      connectionStatus: 'referral_created',
      providerReferralId: 'REF-1',
      actionUrl: 'https://paypal.example/action',
      sellerRef: 'seller-a',
      correlationId: null,
    };
    const connection: SellerConnectionResult = {
      connectionId: 'conn-1',
      sellerRef: 'seller-a',
      trackingId: 'seller-a',
      providerReferralId: 'REF-1',
      providerMerchantId: null,
      connectionStatus: 'referral_created',
      consentStatus: 'unknown',
      readiness: {
        ready: false,
        reasons: ['merchant identity is missing'],
        checks: {
          merchantIdentityPresent: false,
          onboardingCompleted: false,
          consentGranted: false,
          requiredPermissionsGranted: false,
          paymentsReceivable: false,
          primaryEmailConfirmed: false,
          notRevoked: true,
          notRestricted: true,
        },
      },
      latestReferralOperationId: 'op-1',
    };
    expect(referral).not.toHaveProperty('clientSecret');
    expect(referral).not.toHaveProperty('subscriberEmail');
    expect(connection.readiness.ready).toBe(false);
    expect(connection.connectionStatus).not.toBe('active');
  });
});
