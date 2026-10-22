import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../contracts/index';

export type SubscriptionProviderPlanSnapshot = {
  providerPlanId?: string | null;
};

export function assertSubscriptionProviderPlanSnapshotConsistent(
  operation: { providerPlanId: string | null },
  snapshot: SubscriptionProviderPlanSnapshot,
): void {
  const stored = operation.providerPlanId?.trim() ?? '';
  const incoming = snapshot.providerPlanId?.trim() ?? '';
  if (!incoming || !stored) {
    return;
  }
  if (incoming !== stored) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
      `Provider subscription plan ${incoming} does not match stored plan ${stored}`,
    );
  }
}

export function isSubscriptionProviderPlanMismatchError(error: unknown): boolean {
  return (
    error instanceof PaymentReliabilityError &&
    error.code === PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH
  );
}
