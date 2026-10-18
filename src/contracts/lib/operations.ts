import type { PaymentEnvironment } from './capabilities';
import type { PayoutFinancialStatus, PayoutRecipientType } from './payout';
import type { PlanStatus, ProductStatus, SubscriptionStatus } from './subscription';

/** Operation kinds. M4 payout; M5 subscription; M6 seller referral mutation. */
export type PaymentOperationKind =
  | 'checkout'
  | 'capture'
  | 'refund'
  | 'payout_batch'
  | 'payout_item'
  | 'catalog_product'
  | 'billing_plan'
  | 'plan_lifecycle'
  | 'subscription'
  | 'subscription_cancel'
  | 'subscription_suspend'
  | 'subscription_activate'
  | 'seller_referral'
  | 'marketplace_checkout'
  | 'marketplace_capture'
  | 'marketplace_refund';

export type PaymentOperationStatus = 'prepared' | 'submitted' | 'unknown' | 'succeeded' | 'failed';

export type PaymentOperation = {
  operationId: string;
  idempotencyKey: string;
  idempotencyScope: string;
  commandFingerprint: string;
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  providerReferenceId: string | null;
  kind: PaymentOperationKind;
  status: PaymentOperationStatus;
  correlationId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  parentOperationId: string | null;
  approvalUrl: string | null;
  amountMinor: string | null;
  currencyCode: string | null;
  providerOrderId: string | null;
  providerCaptureId: string | null;
  providerRefundId: string | null;
  senderBatchId: string | null;
  senderItemId: string | null;
  providerPayoutBatchId: string | null;
  providerPayoutItemId: string | null;
  payoutStatus: PayoutFinancialStatus | null;
  recipientType: PayoutRecipientType | null;
  maskedDestination: string | null;
  /** Stored server-side for execution/reconciliation; never returned in public DTOs. */
  recipientValue: string | null;
  providerTransactionId: string | null;
  providerFeeMinor: string | null;
  providerFeeCurrency: string | null;
  itemRef: string | null;
  productStatus: ProductStatus | null;
  planStatus: PlanStatus | null;
  subscriptionStatus: SubscriptionStatus | null;
  providerProductId: string | null;
  providerPlanId: string | null;
  providerSubscriptionId: string | null;
  offeringRef: string | null;
  maskedSubscriber: string | null;
  /** Stored server-side; never returned in public DTOs. */
  subscriberRef: string | null;
  subscriberEmail: string | null;
  startTime: string | null;
  nextBillingTime: string | null;
  lifecycleReason: string | null;
  sellerRef: string | null;
  providerReferralId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatePaymentOperationInput = {
  idempotencyKey: string;
  idempotencyScope: string;
  commandFingerprint: string;
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  kind: PaymentOperationKind;
  correlationId?: string | null;
  providerReferenceId?: string | null;
  parentOperationId?: string | null;
  amountMinor?: string | null;
  currencyCode?: string | null;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  senderBatchId?: string | null;
  senderItemId?: string | null;
  providerPayoutBatchId?: string | null;
  providerPayoutItemId?: string | null;
  payoutStatus?: PayoutFinancialStatus | null;
  recipientType?: PayoutRecipientType | null;
  maskedDestination?: string | null;
  recipientValue?: string | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  itemRef?: string | null;
  productStatus?: ProductStatus | null;
  planStatus?: PlanStatus | null;
  subscriptionStatus?: SubscriptionStatus | null;
  providerProductId?: string | null;
  providerPlanId?: string | null;
  providerSubscriptionId?: string | null;
  offeringRef?: string | null;
  maskedSubscriber?: string | null;
  subscriberRef?: string | null;
  subscriberEmail?: string | null;
  startTime?: string | null;
  nextBillingTime?: string | null;
  lifecycleReason?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
};

export type TransitionPaymentOperationInput = {
  operationId: string;
  expectedVersion: number;
  nextStatus: PaymentOperationStatus;
  providerReferenceId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  evidenceId?: string | null;
  approvalUrl?: string | null;
  amountMinor?: string | null;
  currencyCode?: string | null;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  providerRefundId?: string | null;
  senderBatchId?: string | null;
  senderItemId?: string | null;
  providerPayoutBatchId?: string | null;
  providerPayoutItemId?: string | null;
  payoutStatus?: PayoutFinancialStatus | null;
  recipientType?: PayoutRecipientType | null;
  maskedDestination?: string | null;
  recipientValue?: string | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  itemRef?: string | null;
  productStatus?: ProductStatus | null;
  planStatus?: PlanStatus | null;
  subscriptionStatus?: SubscriptionStatus | null;
  providerProductId?: string | null;
  providerPlanId?: string | null;
  providerSubscriptionId?: string | null;
  offeringRef?: string | null;
  maskedSubscriber?: string | null;
  subscriberRef?: string | null;
  subscriberEmail?: string | null;
  startTime?: string | null;
  nextBillingTime?: string | null;
  lifecycleReason?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
  reason: string;
};

export type UpdatePaymentOperationInput = {
  operationId: string;
  expectedVersion: number;
  approvalUrl?: string | null;
  amountMinor?: string | null;
  currencyCode?: string | null;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  providerRefundId?: string | null;
  providerReferenceId?: string | null;
  senderBatchId?: string | null;
  senderItemId?: string | null;
  providerPayoutBatchId?: string | null;
  providerPayoutItemId?: string | null;
  payoutStatus?: PayoutFinancialStatus | null;
  recipientType?: PayoutRecipientType | null;
  maskedDestination?: string | null;
  recipientValue?: string | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  itemRef?: string | null;
  productStatus?: ProductStatus | null;
  planStatus?: PlanStatus | null;
  subscriptionStatus?: SubscriptionStatus | null;
  providerProductId?: string | null;
  providerPlanId?: string | null;
  providerSubscriptionId?: string | null;
  offeringRef?: string | null;
  maskedSubscriber?: string | null;
  subscriberRef?: string | null;
  subscriberEmail?: string | null;
  startTime?: string | null;
  nextBillingTime?: string | null;
  lifecycleReason?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
};

export type PaymentOperationTransitionRecord = {
  transitionId: string;
  operationId: string;
  fromStatus: PaymentOperationStatus;
  toStatus: PaymentOperationStatus;
  evidenceId: string | null;
  reason: string;
  createdAt: string;
};
