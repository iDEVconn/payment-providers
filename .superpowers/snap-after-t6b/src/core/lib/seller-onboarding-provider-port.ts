import type {
  ExecuteCreateSellerReferralRequest,
  ExecuteCreateSellerReferralResult,
  ExecuteFindSellerMerchantRequest,
  ExecuteFindSellerMerchantResult,
  ExecuteGetSellerMerchantStatusRequest,
  ExecuteGetSellerMerchantStatusResult,
  ExecuteGetSellerReferralRequest,
  ExecuteGetSellerReferralResult,
} from '../../contracts/index';

export type SellerOnboardingProviderPort = {
  createReferral(
    input: ExecuteCreateSellerReferralRequest,
  ): Promise<ExecuteCreateSellerReferralResult>;
  getReferral(input: ExecuteGetSellerReferralRequest): Promise<ExecuteGetSellerReferralResult>;
  findMerchantByTrackingId(
    input: ExecuteFindSellerMerchantRequest,
  ): Promise<ExecuteFindSellerMerchantResult>;
  getMerchantStatus(
    input: ExecuteGetSellerMerchantStatusRequest,
  ): Promise<ExecuteGetSellerMerchantStatusResult>;
};

export type SellerOnboardingReconciliationProviderLookup = Pick<
  SellerOnboardingProviderPort,
  'findMerchantByTrackingId' | 'getMerchantStatus' | 'getReferral'
>;
