import type { PaymentEnvironment } from '../../contracts/index';

export type PaymentProviderCredentials = {
  clientId?: string;
  clientSecret?: string;
  requestTimeoutMs?: number;
  webhookId?: string;
};

export type PaymentPartnerConfig = {
  merchantId?: string;
  attributionId?: string;
  sellerOnboardingReturnUrl?: string;
  sellerOnboardingProducts?: string[];
  sellerOnboardingFeatures?: string[];
};

export type PaymentCapabilityFlags = {
  checkout?: boolean;
  refund?: boolean;
  payout?: boolean;
  subscription?: boolean;
  seller_onboarding?: boolean;
  marketplace_checkout?: boolean;
};

/** Explicit payment provider configuration supplied by the host application. */
export type PaymentProviderConfig = {
  providerCode?: string;
  accountRef?: string;
  /** Required tenant identifier — must be set by the consumer composition root. */
  applicationRef: string;
  environment: PaymentEnvironment;
  credentials?: PaymentProviderCredentials;
  capabilityFlags?: Partial<PaymentCapabilityFlags>;
  partner?: PaymentPartnerConfig;
  /** When marketplace is enabled in production, host should set a positive max age (ms). */
  marketplaceSellerReadinessMaxAgeMs?: number;
};
