import type { PaymentEnvironment } from './capabilities';
import type { PaymentOperationStatus } from './operations';

export type SellerOnboardingProviderContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
};

export type SellerConnectionStatus =
  | 'referral_created'
  | 'onboarding_pending'
  | 'restricted'
  | 'active'
  | 'revoked'
  | 'failed';

export type SellerConsentStatus = 'unknown' | 'granted' | 'missing' | 'revoked';

export type SellerConnectionReadinessChecks = {
  merchantIdentityPresent: boolean;
  onboardingCompleted: boolean;
  consentGranted: boolean;
  requiredPermissionsGranted: boolean;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  notRevoked: boolean;
  notRestricted: boolean;
};

export type SellerConnectionReadiness = {
  ready: boolean;
  reasons: string[];
  checks: SellerConnectionReadinessChecks;
};

export type SellerConnectionRecord = {
  connectionId: string;
  applicationRef: string;
  providerCode: string;
  accountRef: string;
  environment: PaymentEnvironment;
  sellerRef: string;
  trackingId: string;
  latestReferralOperationId: string | null;
  providerReferralId: string | null;
  providerMerchantId: string | null;
  connectionStatus: SellerConnectionStatus;
  consentStatus: SellerConsentStatus;
  paymentsReceivable: boolean | null;
  primaryEmailConfirmed: boolean | null;
  requiredPermissionsGranted: boolean | null;
  onboardingCompleted: boolean;
  restricted: boolean;
  readinessReady: boolean;
  readinessReasons: string[];
  normalizedCapabilities: Record<string, boolean>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSellerConnectionInput = {
  applicationRef: string;
  providerCode: string;
  accountRef: string;
  environment: PaymentEnvironment;
  sellerRef: string;
  trackingId: string;
  latestReferralOperationId?: string | null;
  providerReferralId?: string | null;
};

export type UpdateSellerConnectionInput = {
  connectionId: string;
  expectedVersion: number;
  latestReferralOperationId?: string | null;
  providerReferralId?: string | null;
  providerMerchantId?: string | null;
  connectionStatus?: SellerConnectionStatus;
  consentStatus?: SellerConsentStatus;
  paymentsReceivable?: boolean | null;
  primaryEmailConfirmed?: boolean | null;
  requiredPermissionsGranted?: boolean | null;
  onboardingCompleted?: boolean;
  restricted?: boolean;
  readinessReady?: boolean;
  readinessReasons?: string[];
  normalizedCapabilities?: Record<string, boolean>;
};

export type CreateSellerReferralRequest = SellerOnboardingProviderContext & {
  idempotencyKey: string;
  sellerRef: string;
  correlationId?: string | null;
};

export type SellerReferralResult = {
  referralOperationId: string;
  connectionId: string;
  operationStatus: PaymentOperationStatus;
  connectionStatus: SellerConnectionStatus;
  providerReferralId: string | null;
  actionUrl: string | null;
  sellerRef: string;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type GetSellerReferralRequest = SellerOnboardingProviderContext & {
  referralOperationId: string;
};

export type GetSellerReferralResult = SellerReferralResult;

export type GetSellerConnectionRequest = SellerOnboardingProviderContext & {
  sellerRef: string;
};

export type SellerConnectionResult = {
  connectionId: string;
  sellerRef: string;
  trackingId: string;
  providerReferralId: string | null;
  providerMerchantId: string | null;
  connectionStatus: SellerConnectionStatus;
  consentStatus: SellerConsentStatus;
  readiness: SellerConnectionReadiness;
  latestReferralOperationId: string | null;
};

export type ReconcileSellerConnectionRequest = SellerOnboardingProviderContext & {
  sellerRef: string;
};

export type ReconcileSellerConnectionResult = SellerConnectionResult;

export type ExecuteCreateSellerReferralRequest = SellerOnboardingProviderContext & {
  providerRequestId: string;
  trackingId: string;
};

export type ExecuteCreateSellerReferralResult = {
  providerReferralId: string;
  actionUrl: string | null;
  providerDebugId?: string | null;
};

export type ExecuteGetSellerReferralRequest = SellerOnboardingProviderContext & {
  providerReferralId: string;
};

export type ExecuteGetSellerReferralResult = {
  providerReferralId: string;
  actionUrl: string | null;
  providerDebugId?: string | null;
};

export type ExecuteFindSellerMerchantRequest = SellerOnboardingProviderContext & {
  trackingId: string;
};

export type ExecuteFindSellerMerchantResult = {
  providerMerchantId: string | null;
  trackingId: string;
  /** Number of merchant matches returned by the provider for this tracking id. */
  matchCount?: number;
  /** True when the provider returned more than one scoped merchant match. */
  ambiguous?: boolean;
  providerDebugId?: string | null;
};

export type ExecuteGetSellerMerchantStatusRequest = SellerOnboardingProviderContext & {
  providerMerchantId: string;
};

export type ExecuteGetSellerMerchantStatusResult = {
  providerMerchantId: string;
  trackingId: string | null;
  paymentsReceivable: boolean | null;
  primaryEmailConfirmed: boolean | null;
  grantedScopes: string[];
  productActive: boolean | null;
  hasLimitations: boolean;
  consentPresent: boolean;
  providerDebugId?: string | null;
};
