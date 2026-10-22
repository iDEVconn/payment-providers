import type {
  SellerConnectionReadiness,
  SellerConnectionRecord,
  SellerConsentStatus,
} from '../../contracts/index';

export function evaluateSellerConnectionReadiness(input: {
  providerMerchantId: string | null;
  consentStatus: SellerConsentStatus;
  paymentsReceivable: boolean | null;
  primaryEmailConfirmed: boolean | null;
  requiredPermissionsGranted: boolean | null;
  onboardingCompleted: boolean;
  restricted: boolean;
}): SellerConnectionReadiness {
  const checks = {
    merchantIdentityPresent: Boolean(input.providerMerchantId),
    onboardingCompleted: input.onboardingCompleted,
    consentGranted: input.consentStatus === 'granted',
    requiredPermissionsGranted: input.requiredPermissionsGranted === true,
    paymentsReceivable: input.paymentsReceivable === true,
    primaryEmailConfirmed: input.primaryEmailConfirmed === true,
    notRevoked: input.consentStatus !== 'revoked',
    notRestricted: !input.restricted,
  };
  const reasons: string[] = [];
  if (!checks.merchantIdentityPresent) {
    reasons.push('merchant identity is missing');
  }
  if (!checks.onboardingCompleted) {
    reasons.push('onboarding is not complete');
  }
  if (!checks.consentGranted) {
    reasons.push('seller consent is not granted');
  }
  if (!checks.requiredPermissionsGranted) {
    reasons.push('required permissions are missing');
  }
  if (!checks.paymentsReceivable) {
    reasons.push('payments are not receivable');
  }
  if (!checks.primaryEmailConfirmed) {
    reasons.push('primary email is not confirmed');
  }
  if (!checks.notRevoked) {
    reasons.push('seller consent was revoked');
  }
  if (!checks.notRestricted) {
    reasons.push('seller account is restricted');
  }
  return {
    ready: reasons.length === 0,
    reasons,
    checks,
  };
}

export function readinessFromConnection(
  connection: SellerConnectionRecord,
): SellerConnectionReadiness {
  return evaluateSellerConnectionReadiness(connection);
}
