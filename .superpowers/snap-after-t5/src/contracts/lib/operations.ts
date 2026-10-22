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
  /** Last accepted PayPal subscription resource update/create time for webhook ordering. */
  providerSubscriptionStateAt: string | null;
  sellerRef: string | null;
  providerReferralId: string | null;
  executionLeaseExpiresAt: string | null;
  executionOwnerToken: string | null;
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
  providerSubscriptionStateAt?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
  executionLeaseExpiresAt?: string | null;
  executionOwnerToken?: string | null;
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
  providerSubscriptionStateAt?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
  executionLeaseExpiresAt?: string | null;
  executionOwnerToken?: string | null;
  expectedExecutionOwnerToken?: string | null;
  /** Free text for people; never read by the services (issue #23). */
  reason: string;
  /**
   * Typed marker of a claim transition. Stores persist it on the history row as given (`null`
   * when absent); services identify claims by it, never by `reason`.
   */
  transitionKind?: OperationTransitionKind | null;
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
  providerSubscriptionStateAt?: string | null;
  sellerRef?: string | null;
  providerReferralId?: string | null;
};

/**
 * Kind of a claim transition: `claim_execution` is the first claim of a `prepared` operation for a
 * provider call (`claimOperationForExecution`, or a create execution lease taken from `prepared`);
 * `claim_retry` is a create execution lease taken from `unknown` or a stale `submitted`.
 */
export type OperationTransitionKind = 'claim_execution' | 'claim_retry';

export const OPERATION_TRANSITION_KIND = {
  CLAIM_EXECUTION: 'claim_execution',
  CLAIM_RETRY: 'claim_retry',
} as const satisfies Record<string, OperationTransitionKind>;

export type PaymentOperationTransitionRecord = {
  transitionId: string;
  operationId: string;
  fromStatus: PaymentOperationStatus;
  toStatus: PaymentOperationStatus;
  evidenceId: string | null;
  reason: string;
  /** Absent or `null` for ordinary transitions and for rows written before 0.3. */
  transitionKind?: OperationTransitionKind | null;
  createdAt: string;
};
