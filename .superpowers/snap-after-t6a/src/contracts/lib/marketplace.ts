import type { CheckoutProviderContext } from './checkout';
import type { CanonicalMoney } from './money';
import type { PaymentOperationStatus } from './operations';

export type MarketplaceOrderStatus =
  | 'created'
  | 'approved'
  | 'captured'
  | 'partially_captured'
  | 'failed'
  | 'unknown';

export type MarketplaceUnitStatus =
  | 'pending'
  | 'captured'
  | 'declined'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'unknown';

export type MarketplaceUnitInput = {
  sellerRef: string;
  referenceId: string;
  amount: CanonicalMoney;
  /** Consuming-app authorized fee; trusted server API only. Same currency; strictly less than amount. */
  platformFee?: CanonicalMoney | null;
};

export type CreateMarketplaceOrderRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  units: MarketplaceUnitInput[];
};

export type GetMarketplaceOrderRequest = CheckoutProviderContext & {
  marketplaceOperationId: string;
};

export type CaptureMarketplaceOrderRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  marketplaceOperationId: string;
  providerOrderId: string;
};

export type RefundMarketplaceUnitRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  marketplaceOperationId: string;
  referenceId: string;
  providerCaptureId: string;
  amount?: CanonicalMoney | null;
  platformFeeRefund?: CanonicalMoney | null;
};

export type MarketplaceUnitResult = {
  referenceId: string;
  sellerRef: string;
  providerMerchantId: string | null;
  unitStatus: MarketplaceUnitStatus;
  amount: CanonicalMoney;
  platformFee: CanonicalMoney | null;
  providerCaptureId: string | null;
  providerFee: CanonicalMoney | null;
  netAmount: CanonicalMoney | null;
  refundedAmount: CanonicalMoney | null;
};

export type MarketplaceOrderResult = {
  operationId: string;
  operationStatus: PaymentOperationStatus;
  providerOrderId: string | null;
  marketplaceStatus: MarketplaceOrderStatus;
  approvalUrl: string | null;
  units: MarketplaceUnitResult[];
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type RefundMarketplaceUnitResult = {
  operationId: string;
  operationStatus: PaymentOperationStatus;
  marketplaceOperationId: string;
  referenceId: string;
  providerCaptureId: string;
  providerRefundId: string | null;
  refundStatus: 'pending' | 'completed' | 'failed' | 'unknown';
  amount: CanonicalMoney | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type MarketplacePurchaseUnitRecord = {
  unitId: string;
  operationId: string;
  referenceId: string;
  sellerRef: string;
  providerMerchantId: string | null;
  amountMinor: string;
  currencyCode: string;
  platformFeeMinor: string | null;
  platformFeeCurrency: string | null;
  unitStatus: MarketplaceUnitStatus;
  providerCaptureId: string | null;
  providerFeeMinor: string | null;
  providerFeeCurrency: string | null;
  netAmountMinor: string | null;
  refundedMinor: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InsertMarketplacePurchaseUnitInput = {
  operationId: string;
  referenceId: string;
  sellerRef: string;
  providerMerchantId: string | null;
  amountMinor: string;
  currencyCode: string;
  platformFeeMinor?: string | null;
  platformFeeCurrency?: string | null;
  unitStatus?: MarketplaceUnitStatus;
};

export type UpdateMarketplacePurchaseUnitInput = {
  unitId: string;
  expectedVersion: number;
  unitStatus?: MarketplaceUnitStatus;
  providerCaptureId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  netAmountMinor?: string | null;
  refundedMinor?: string;
};

export type ExecuteMarketplaceUnit = {
  referenceId: string;
  providerMerchantId: string;
  amount: CanonicalMoney;
  platformFee?: CanonicalMoney | null;
};

export type ExecuteCreateMarketplaceOrderRequest = CheckoutProviderContext & {
  providerRequestId: string;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  units: ExecuteMarketplaceUnit[];
};

export type ExecuteMarketplaceUnitSnapshot = {
  referenceId: string;
  providerMerchantId: string;
  amount: CanonicalMoney;
  platformFee: CanonicalMoney | null;
  unitStatus: MarketplaceUnitStatus;
  providerCaptureId: string | null;
  providerFee: CanonicalMoney | null;
  netAmount: CanonicalMoney | null;
};

export type ExecuteCreateMarketplaceOrderResult = {
  providerOrderId: string;
  marketplaceStatus: MarketplaceOrderStatus;
  approvalUrl: string | null;
  units: ExecuteMarketplaceUnitSnapshot[];
  providerDebugId?: string | null;
};

export type ExecuteGetMarketplaceOrderRequest = CheckoutProviderContext & {
  providerOrderId: string;
};

export type ExecuteGetMarketplaceOrderResult = {
  providerOrderId: string;
  marketplaceStatus: MarketplaceOrderStatus;
  approvalUrl: string | null;
  units: ExecuteMarketplaceUnitSnapshot[];
  providerDebugId?: string | null;
};

export type ExecuteCaptureMarketplaceOrderRequest = CheckoutProviderContext & {
  providerRequestId: string;
  providerOrderId: string;
};

export type ExecuteCaptureMarketplaceOrderResult = {
  providerOrderId: string;
  marketplaceStatus: MarketplaceOrderStatus;
  units: ExecuteMarketplaceUnitSnapshot[];
  httpStatus: number;
  providerDebugId?: string | null;
};

export type ExecuteRefundMarketplaceUnitRequest = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: CheckoutProviderContext['environment'];
  providerRequestId: string;
  providerCaptureId: string;
  amount?: CanonicalMoney | null;
  platformFeeRefund?: CanonicalMoney | null;
};

export type ExecuteRefundMarketplaceUnitResult = {
  providerRefundId: string;
  refundStatus: 'pending' | 'completed' | 'failed' | 'unknown';
  amount: CanonicalMoney | null;
  providerDebugId?: string | null;
};
