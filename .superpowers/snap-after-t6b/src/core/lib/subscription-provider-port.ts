import type {
  ExecuteCreateBillingPlanRequest,
  ExecuteCreateBillingPlanResult,
  ExecuteCreateCatalogProductRequest,
  ExecuteCreateCatalogProductResult,
  ExecuteCreateSubscriptionRequest,
  ExecuteCreateSubscriptionResult,
  ExecuteGetBillingPlanRequest,
  ExecuteGetBillingPlanResult,
  ExecuteGetCatalogProductRequest,
  ExecuteGetCatalogProductResult,
  ExecuteGetSubscriptionRequest,
  ExecuteGetSubscriptionResult,
  ExecutePlanLifecycleRequest,
  ExecutePlanLifecycleResult,
  ExecuteSubscriptionLifecycleRequest,
  ExecuteSubscriptionLifecycleResult,
} from '../../contracts/index';

export type SubscriptionProviderPort = {
  createProduct(
    input: ExecuteCreateCatalogProductRequest,
  ): Promise<ExecuteCreateCatalogProductResult>;
  getProduct(input: ExecuteGetCatalogProductRequest): Promise<ExecuteGetCatalogProductResult>;
  createPlan(input: ExecuteCreateBillingPlanRequest): Promise<ExecuteCreateBillingPlanResult>;
  getPlan(input: ExecuteGetBillingPlanRequest): Promise<ExecuteGetBillingPlanResult>;
  activatePlan(input: ExecutePlanLifecycleRequest): Promise<ExecutePlanLifecycleResult>;
  deactivatePlan(input: ExecutePlanLifecycleRequest): Promise<ExecutePlanLifecycleResult>;
  createSubscription(
    input: ExecuteCreateSubscriptionRequest,
  ): Promise<ExecuteCreateSubscriptionResult>;
  getSubscription(input: ExecuteGetSubscriptionRequest): Promise<ExecuteGetSubscriptionResult>;
  cancelSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult>;
  suspendSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult>;
  activateSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult>;
};

export type SubscriptionReconciliationProviderLookup = Pick<
  SubscriptionProviderPort,
  'getProduct' | 'getPlan' | 'getSubscription'
>;
