import type { PaymentEnvironment, PaymentOperation } from '../../contracts/index';

export type BillingPlanOperationBindingRequirements = Readonly<{
  expectedEnvironment: PaymentEnvironment;
  expectedOfferingRef: string;
}>;

/**
 * Parent billing-plan preconditions for SubscriptionLifecycleService.createSubscription.
 * Source: subscription-lifecycle-service.ts — requires kind billing_plan and providerPlanId only.
 * Operation status is not inspected on the parent plan.
 */
export function validateBillingPlanOperationForSubscriptionLifecycle(
  operation: PaymentOperation | null,
): 'ready' | 'not_ready' {
  if (!operation || operation.kind !== 'billing_plan' || !operation.providerPlanId?.trim()) {
    return 'not_ready';
  }
  return 'ready';
}

/**
 * Gateway binding validation: lifecycle readiness plus environment and offeringRef alignment.
 */
export function validateBillingPlanOperationBinding(
  operation: PaymentOperation | null,
  requirements: BillingPlanOperationBindingRequirements,
): 'ready' | 'not_ready' {
  if (validateBillingPlanOperationForSubscriptionLifecycle(operation) !== 'ready') {
    return 'not_ready';
  }
  if (operation?.planStatus !== 'active') {
    return 'not_ready';
  }
  if (operation!.environment !== requirements.expectedEnvironment) {
    return 'not_ready';
  }
  const offeringRef = operation!.offeringRef?.trim();
  if (!offeringRef || offeringRef !== requirements.expectedOfferingRef.trim()) {
    return 'not_ready';
  }
  return 'ready';
}
