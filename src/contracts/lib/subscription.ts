import type { PaymentEnvironment } from './capabilities';
import type { CanonicalMoney } from './money';
import type { PaymentOperationStatus } from './operations';

export type SubscriptionProviderContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
};

export type ProductType = 'PHYSICAL' | 'DIGITAL' | 'SERVICE';

export type ProductStatus = 'created' | 'unknown';

export type PlanStatus = 'created' | 'active' | 'inactive' | 'unknown';

export type SubscriptionStatus =
  | 'approval_pending'
  | 'approved'
  | 'active'
  | 'suspended'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export type BillingIntervalUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type BillingTenureType = 'TRIAL' | 'REGULAR';

export type BillingCycleInput = {
  tenureType: BillingTenureType;
  sequence: number;
  totalCycles: number;
  intervalUnit: BillingIntervalUnit;
  intervalCount: number;
  price?: CanonicalMoney | null;
};

export type PaymentPreferencesInput = {
  autoBillOutstanding?: boolean;
  setupFee?: CanonicalMoney | null;
  setupFeeFailureAction?: 'CONTINUE' | 'CANCEL' | null;
  paymentFailureThreshold?: number | null;
};

export type CreateCatalogProductRequest = SubscriptionProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  name: string;
  description?: string | null;
  type: ProductType;
  category?: string | null;
  homeUrl?: string | null;
  imageUrl?: string | null;
};

export type CatalogProductResult = {
  productOperationId: string;
  operationStatus: PaymentOperationStatus;
  productStatus: ProductStatus;
  providerProductId: string | null;
  name: string;
  type: ProductType;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type GetCatalogProductRequest = SubscriptionProviderContext & {
  productOperationId: string;
};

export type GetCatalogProductResult = CatalogProductResult;

export type CreateBillingPlanRequest = SubscriptionProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  offeringRef?: string | null;
  productOperationId: string;
  name: string;
  description?: string | null;
  status?: 'CREATED' | 'ACTIVE';
  billingCycles: BillingCycleInput[];
  paymentPreferences: PaymentPreferencesInput;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type BillingPlanResult = {
  planOperationId: string;
  operationStatus: PaymentOperationStatus;
  planStatus: PlanStatus;
  offeringRef: string | null;
  providerPlanId: string | null;
  providerProductId: string | null;
  name: string;
  billingCycles: BillingCycleInput[];
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type GetBillingPlanRequest = SubscriptionProviderContext & {
  planOperationId: string;
};

export type GetBillingPlanResult = BillingPlanResult;

export type PlanLifecycleRequest = SubscriptionProviderContext & {
  idempotencyKey: string;
  planOperationId: string;
  correlationId?: string | null;
};

export type PlanLifecycleResult = BillingPlanResult;

export type SubscriberInput = {
  /** Opaque host identifier; never echoed in errors. */
  subscriberRef: string;
  /** Optional email for PayPal subscriber; server-side only. */
  email?: string | null;
};

/** Plan referenced through a stored Payment `billing_plan` operation. */
export type SubscriptionPlanOperationReference = {
  planOperationId: string;
  providerPlanId?: never;
  offeringRef?: never;
};

/**
 * Plan referenced directly by its provider plan id. `offeringRef` must come
 * from trusted server configuration, never from a browser request.
 */
export type SubscriptionProviderPlanReference = {
  providerPlanId: string;
  offeringRef: string;
  planOperationId?: never;
};

export type CreateSubscriptionRequest = SubscriptionProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  subscriber: SubscriberInput;
  returnUrl?: string | null;
  cancelUrl?: string | null;
} & (SubscriptionPlanOperationReference | SubscriptionProviderPlanReference);

export type SubscriptionResult = {
  subscriptionOperationId: string;
  operationStatus: PaymentOperationStatus;
  subscriptionStatus: SubscriptionStatus;
  providerSubscriptionId: string | null;
  providerPlanId: string | null;
  approvalUrl: string | null;
  maskedSubscriber: string;
  startTime: string | null;
  nextBillingTime: string | null;
  lifecycleReason: string | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type GetSubscriptionRequest = SubscriptionProviderContext & {
  subscriptionOperationId: string;
};

export type GetSubscriptionResult = SubscriptionResult;

export type SubscriptionLifecycleCommandRequest = SubscriptionProviderContext & {
  idempotencyKey: string;
  subscriptionOperationId: string;
  reason: string;
  correlationId?: string | null;
};

export type SubscriptionLifecycleCommandResult = SubscriptionResult;

/** Provider execution — no durable fields. */
export type ExecuteCreateCatalogProductRequest = SubscriptionProviderContext & {
  providerRequestId: string;
  name: string;
  description?: string | null;
  type: ProductType;
  category?: string | null;
  homeUrl?: string | null;
  imageUrl?: string | null;
};

export type ExecuteCreateCatalogProductResult = {
  providerProductId: string;
  productStatus: ProductStatus;
  providerDebugId?: string | null;
};

export type ExecuteGetCatalogProductRequest = SubscriptionProviderContext & {
  providerProductId: string;
};

export type ExecuteGetCatalogProductResult = {
  providerProductId: string;
  name: string;
  type: ProductType;
  productStatus: ProductStatus;
  providerDebugId?: string | null;
};

export type ExecuteCreateBillingPlanRequest = SubscriptionProviderContext & {
  providerRequestId: string;
  providerProductId: string;
  name: string;
  description?: string | null;
  status?: 'CREATED' | 'ACTIVE';
  billingCycles: BillingCycleInput[];
  paymentPreferences: PaymentPreferencesInput;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type ExecuteCreateBillingPlanResult = {
  providerPlanId: string;
  providerProductId: string;
  planStatus: PlanStatus;
  providerDebugId?: string | null;
};

export type ExecuteGetBillingPlanRequest = SubscriptionProviderContext & {
  providerPlanId: string;
};

export type ExecuteGetBillingPlanResult = {
  providerPlanId: string;
  providerProductId: string | null;
  planStatus: PlanStatus;
  name: string | null;
  providerDebugId?: string | null;
};

export type ExecutePlanLifecycleRequest = SubscriptionProviderContext & {
  providerPlanId: string;
};

export type ExecutePlanLifecycleResult = ExecuteGetBillingPlanResult;

export type ExecuteCreateSubscriptionRequest = SubscriptionProviderContext & {
  providerRequestId: string;
  providerPlanId: string;
  subscriberEmail?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type ExecuteCreateSubscriptionResult = {
  providerSubscriptionId: string;
  providerPlanId: string;
  subscriptionStatus: SubscriptionStatus;
  approvalUrl: string | null;
  startTime: string | null;
  nextBillingTime: string | null;
  providerDebugId?: string | null;
};

export type ExecuteGetSubscriptionRequest = SubscriptionProviderContext & {
  providerSubscriptionId: string;
};

export type ExecuteGetSubscriptionResult = {
  providerSubscriptionId: string;
  providerPlanId: string | null;
  subscriptionStatus: SubscriptionStatus;
  approvalUrl: string | null;
  startTime: string | null;
  nextBillingTime: string | null;
  lifecycleReason: string | null;
  providerDebugId?: string | null;
};

export type ExecuteSubscriptionLifecycleRequest = SubscriptionProviderContext & {
  providerSubscriptionId: string;
  reason: string;
};

export type ExecuteSubscriptionLifecycleResult = ExecuteGetSubscriptionResult;
