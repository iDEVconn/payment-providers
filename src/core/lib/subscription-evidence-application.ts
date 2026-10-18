import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperation,
  type PaymentOperationStatus,
  type PlanStatus,
  type SubscriptionStatus,
} from '../../contracts/index';
import {
  assertSubscriptionTransitionAllowed,
  planStatusToOperationStatus,
  subscriptionStatusToOperationStatus,
} from './subscription-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import { assertTransitionAllowed } from './transition-policy';

function resolveExecutionTransition(
  currentStatus: PaymentOperationStatus,
  desiredStatus: PaymentOperationStatus,
): PaymentOperationStatus {
  if (desiredStatus === currentStatus) {
    return currentStatus;
  }

  try {
    assertTransitionAllowed(currentStatus, desiredStatus);
    return desiredStatus;
  } catch (error) {
    if (
      error instanceof PaymentReliabilityError &&
      error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED
    ) {
      return currentStatus;
    }
    throw error;
  }
}

async function persistDomainAwareOperationUpdate(
  store: PaymentReliabilityStore,
  operation: PaymentOperation,
  input: {
    nextExecution: PaymentOperationStatus;
    reason: string;
    evidenceId?: string | null;
    providerReferenceId?: string | null;
    providerSubscriptionId?: string | null;
    providerPlanId?: string | null;
    approvalUrl?: string | null;
    startTime?: string | null;
    nextBillingTime?: string | null;
    lifecycleReason?: string | null;
    planStatus?: PlanStatus;
    subscriptionStatus?: SubscriptionStatus;
  },
): Promise<PaymentOperation> {
  const domainChanged =
    (input.planStatus !== undefined && input.planStatus !== operation.planStatus) ||
    (input.subscriptionStatus !== undefined &&
      input.subscriptionStatus !== operation.subscriptionStatus);

  if (input.nextExecution === operation.status) {
    if (!domainChanged) {
      return operation;
    }

    return store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      planStatus: input.planStatus,
      subscriptionStatus: input.subscriptionStatus,
      providerReferenceId: input.providerReferenceId ?? undefined,
      providerSubscriptionId: input.providerSubscriptionId ?? undefined,
      providerPlanId: input.providerPlanId ?? undefined,
      approvalUrl: input.approvalUrl ?? undefined,
      startTime: input.startTime ?? undefined,
      nextBillingTime: input.nextBillingTime ?? undefined,
      lifecycleReason: input.lifecycleReason ?? undefined,
    });
  }

  return store.transitionOperation({
    operationId: operation.operationId,
    expectedVersion: operation.version,
    nextStatus: input.nextExecution,
    planStatus: input.planStatus,
    subscriptionStatus: input.subscriptionStatus,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerSubscriptionId: input.providerSubscriptionId ?? undefined,
    providerPlanId: input.providerPlanId ?? undefined,
    approvalUrl: input.approvalUrl ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    lifecycleReason: input.lifecycleReason ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
}

export type ApplySubscriptionTransitionInput = {
  operation: PaymentOperation;
  subscriptionStatus: SubscriptionStatus;
  evidenceId?: string | null;
  reason: string;
  providerReferenceId?: string | null;
  providerSubscriptionId?: string | null;
  providerPlanId?: string | null;
  approvalUrl?: string | null;
  startTime?: string | null;
  nextBillingTime?: string | null;
  lifecycleReason?: string | null;
};

export type ApplyPlanTransitionInput = {
  operation: PaymentOperation;
  planStatus: PlanStatus;
  evidenceId?: string | null;
  reason: string;
  providerReferenceId?: string | null;
  providerPlanId?: string | null;
};

function isDuplicateSubscriptionEvidence(
  operation: PaymentOperation,
  subscriptionStatus: SubscriptionStatus,
): boolean {
  const current = operation.subscriptionStatus ?? 'approval_pending';
  const nextExecution = subscriptionStatusToOperationStatus(subscriptionStatus);
  return current === subscriptionStatus && operation.status === nextExecution;
}

export async function applySubscriptionTransition(
  store: PaymentReliabilityStore,
  input: ApplySubscriptionTransitionInput,
): Promise<PaymentOperation> {
  const { operation, subscriptionStatus } = input;

  if (isDuplicateSubscriptionEvidence(operation, subscriptionStatus)) {
    return operation;
  }

  const current = operation.subscriptionStatus ?? 'approval_pending';
  assertSubscriptionTransitionAllowed(current, subscriptionStatus);

  const nextExecution = resolveExecutionTransition(
    operation.status,
    subscriptionStatusToOperationStatus(subscriptionStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    subscriptionStatus,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerSubscriptionId: input.providerSubscriptionId ?? undefined,
    providerPlanId: input.providerPlanId ?? undefined,
    approvalUrl: input.approvalUrl ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    lifecycleReason: input.lifecycleReason ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
}

export async function applyPlanTransition(
  store: PaymentReliabilityStore,
  input: ApplyPlanTransitionInput,
): Promise<PaymentOperation> {
  const { operation, planStatus } = input;
  if (operation.planStatus === planStatus) {
    return operation;
  }

  const nextExecution = resolveExecutionTransition(
    operation.status,
    planStatusToOperationStatus(planStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    planStatus,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerPlanId: input.providerPlanId ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
}

export async function applyPlanDomainUpdate(
  store: PaymentReliabilityStore,
  operation: PaymentOperation,
  input: {
    planStatus: PlanStatus;
    reason: string;
  },
): Promise<PaymentOperation> {
  if (operation.planStatus === input.planStatus) {
    return operation;
  }

  const nextExecution = resolveExecutionTransition(
    operation.status,
    planStatusToOperationStatus(input.planStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    planStatus: input.planStatus,
    reason: input.reason,
  });
}

export async function applySubscriptionDomainUpdate(
  store: PaymentReliabilityStore,
  operation: PaymentOperation,
  input: {
    subscriptionStatus: SubscriptionStatus;
    reason: string;
    lifecycleReason?: string | null;
    startTime?: string | null;
    nextBillingTime?: string | null;
  },
): Promise<PaymentOperation> {
  const current = operation.subscriptionStatus ?? 'approval_pending';
  assertSubscriptionTransitionAllowed(current, input.subscriptionStatus);

  const nextExecution = resolveExecutionTransition(
    operation.status,
    subscriptionStatusToOperationStatus(input.subscriptionStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    subscriptionStatus: input.subscriptionStatus,
    lifecycleReason: input.lifecycleReason ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    reason: input.reason,
  });
}
