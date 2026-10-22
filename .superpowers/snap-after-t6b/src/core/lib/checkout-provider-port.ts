import type {
  ExecuteCaptureCheckoutOrderRequest,
  ExecuteCaptureCheckoutOrderResult,
  ExecuteCreateCheckoutOrderRequest,
  ExecuteCreateCheckoutOrderResult,
  ExecuteGetCheckoutOrderRequest,
  ExecuteGetCheckoutOrderResult,
  ExecuteGetPayoutBatchRequest,
  ExecuteGetPayoutBatchResult,
  ExecuteGetPayoutItemRequest,
  ExecuteGetPayoutItemResult,
  ExecuteGetRefundRequest,
  ExecuteGetRefundResult,
  ExecuteGetBillingPlanRequest,
  ExecuteGetBillingPlanResult,
  ExecuteGetCatalogProductRequest,
  ExecuteGetCatalogProductResult,
  ExecuteGetSubscriptionRequest,
  ExecuteGetSubscriptionResult,
  ExecuteFindSellerMerchantRequest,
  ExecuteFindSellerMerchantResult,
  ExecuteGetSellerMerchantStatusRequest,
  ExecuteGetSellerMerchantStatusResult,
  ExecuteGetSellerReferralRequest,
  ExecuteGetSellerReferralResult,
  ExecuteGetMarketplaceOrderRequest,
  ExecuteGetMarketplaceOrderResult,
  ExecuteRefundCaptureRequest,
  ExecuteRefundCaptureResult,
} from '../../contracts/index';

export type CheckoutProviderExecutionError = {
  code: string;
  message: string;
  retryable: boolean;
  uncertain: boolean;
  providerDebugId?: string | null;
};

export type CheckoutProviderPort = {
  createOrder(input: ExecuteCreateCheckoutOrderRequest): Promise<ExecuteCreateCheckoutOrderResult>;
  getOrder(input: ExecuteGetCheckoutOrderRequest): Promise<ExecuteGetCheckoutOrderResult>;
  captureOrder(
    input: ExecuteCaptureCheckoutOrderRequest,
  ): Promise<ExecuteCaptureCheckoutOrderResult>;
  refundCapture(input: ExecuteRefundCaptureRequest): Promise<ExecuteRefundCaptureResult>;
  getRefund(input: ExecuteGetRefundRequest): Promise<ExecuteGetRefundResult>;
};

export type ReconciliationProviderLookup = Pick<CheckoutProviderPort, 'getOrder' | 'getRefund'> & {
  getPayoutBatch(input: ExecuteGetPayoutBatchRequest): Promise<ExecuteGetPayoutBatchResult>;
  getPayoutItem(input: ExecuteGetPayoutItemRequest): Promise<ExecuteGetPayoutItemResult>;
  getProduct(input: ExecuteGetCatalogProductRequest): Promise<ExecuteGetCatalogProductResult>;
  getPlan(input: ExecuteGetBillingPlanRequest): Promise<ExecuteGetBillingPlanResult>;
  getSubscription(input: ExecuteGetSubscriptionRequest): Promise<ExecuteGetSubscriptionResult>;
  getReferral(input: ExecuteGetSellerReferralRequest): Promise<ExecuteGetSellerReferralResult>;
  findMerchantByTrackingId(
    input: ExecuteFindSellerMerchantRequest,
  ): Promise<ExecuteFindSellerMerchantResult>;
  getMerchantStatus(
    input: ExecuteGetSellerMerchantStatusRequest,
  ): Promise<ExecuteGetSellerMerchantStatusResult>;
  getMarketplaceOrder(
    input: ExecuteGetMarketplaceOrderRequest,
  ): Promise<ExecuteGetMarketplaceOrderResult>;
};
