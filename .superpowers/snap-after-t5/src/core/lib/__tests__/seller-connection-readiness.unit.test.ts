import { describe, expect, it } from 'vitest';
import { evaluateSellerConnectionReadiness } from '../seller-connection-readiness';

describe('evaluateSellerConnectionReadiness', () => {
  it('is not ready from merchant id alone', () => {
    const result = evaluateSellerConnectionReadiness({
      providerMerchantId: 'MERCHANT-1',
      consentStatus: 'unknown',
      paymentsReceivable: null,
      primaryEmailConfirmed: null,
      requiredPermissionsGranted: null,
      onboardingCompleted: false,
      restricted: false,
    });
    expect(result.ready).toBe(false);
    expect(result.checks.merchantIdentityPresent).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('is ready only when every verified check passes', () => {
    const result = evaluateSellerConnectionReadiness({
      providerMerchantId: 'MERCHANT-1',
      consentStatus: 'granted',
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      requiredPermissionsGranted: true,
      onboardingCompleted: true,
      restricted: false,
    });
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('is not ready when consent is revoked', () => {
    const result = evaluateSellerConnectionReadiness({
      providerMerchantId: 'MERCHANT-1',
      consentStatus: 'revoked',
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      requiredPermissionsGranted: true,
      onboardingCompleted: true,
      restricted: false,
    });
    expect(result.ready).toBe(false);
    expect(result.checks.notRevoked).toBe(false);
  });
});
