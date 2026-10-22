import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperation,
  type PaymentOperationStatus,
  type PlanStatus,
  type SubscriptionStatus,
} from '../../contracts/index';
import {
  evaluateSubscriptionProviderStateOrdering,
  planStatusToOperationStatus,
  readSubscriptionProviderStateWatermark,
  resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist,
  resolveSubscriptionStatusTransition,
  subscriptionStatusToOperationStatus,
  type SubscriptionStateApplySource,
} from './subscription-transition-policy';
import type { OperationStore } from './persistence/payment-reliability-store';
import { assertTransitionAllowed } from './transition-policy';

const SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES = 8;

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

function isTransitionVersionConflict(error: unknown): boolean {
  return (
    error instanceof PaymentReliabilityError &&
    error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT
  );
}

async function persistDomainAwareOperationUpdate(
  store: OperationStore,
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
    providerStateWatermark?: string;
  },
): Promise<PaymentOperation> {
  const subscriptionStatus =
    input.subscriptionStatus !== undefined
      ? resolveSubscriptionStatusTransition(
          operation.subscriptionStatus ?? 'approval_pending',
          input.subscriptionStatus,
        )
      : undefined;

  const providerSubscriptionStateAt = input.providerStateWatermark;
  const providerTransactionId =
    input.providerStateWatermark !== undefined
      ? resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist(operation)
      : undefined;
  const watermarkChanged =
    providerSubscriptionStateAt !== undefined &&
    providerSubscriptionStateAt !== operation.providerSubscriptionStateAt;
  const providerTransactionIdChanged =
    providerTransactionId !== undefined &&
    providerTransactionId !== operation.providerTransactionId;

  const domainChanged =
    (input.planStatus !== undefined && input.planStatus !== operation.planStatus) ||
    (subscriptionStatus !== undefined && subscriptionStatus !== operation.subscriptionStatus) ||
    watermarkChanged ||
    providerTransactionIdChanged;

  if (input.nextExecution === operation.status) {
    if (!domainChanged) {
      return operation;
    }

    return store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      planStatus: input.planStatus,
      subscriptionStatus,
      providerSubscriptionStateAt,
      providerTransactionId,
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
    subscriptionStatus,
    providerSubscriptionStateAt,
    providerTransactionId,
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
  providerStateTimestamp?: string | null;
  applySource?: SubscriptionStateApplySource;
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

async function applySubscriptionTransitionOnce(
  store: OperationStore,
  input: ApplySubscriptionTransitionInput,
): Promise<PaymentOperation> {
  const { operation, subscriptionStatus } = input;
  const current = operation.subscriptionStatus ?? 'approval_pending';
  const resolvedStatus = resolveSubscriptionStatusTransition(current, subscriptionStatus);
  const ordering = evaluateSubscriptionProviderStateOrdering({
    operation,
    desiredStatus: resolvedStatus,
    providerStateTimestamp: input.providerStateTimestamp ?? null,
    applySource: input.applySource ?? 'webhook',
  });
  if (ordering.action === 'noop') {
    return operation;
  }

  const watermarkUnchanged =
    ordering.providerStateWatermark !== null &&
    ordering.providerStateWatermark === readSubscriptionProviderStateWatermark(operation);

  if (
    isDuplicateSubscriptionEvidence(operation, resolvedStatus) &&
    (ordering.providerStateWatermark === null || watermarkUnchanged)
  ) {
    return operation;
  }

  const nextExecution = resolveExecutionTransition(
    operation.status,
    subscriptionStatusToOperationStatus(resolvedStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    subscriptionStatus: resolvedStatus,
    ...(ordering.providerStateWatermark !== null
      ? { providerStateWatermark: ordering.providerStateWatermark }
      : {}),
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

export async function applySubscriptionTransition(
  store: OperationStore,
  input: ApplySubscriptionTransitionInput,
): Promise<PaymentOperation> {
  let operation = input.operation;

  for (let attempt = 0; attempt < SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES; attempt += 1) {
    try {
      return await applySubscriptionTransitionOnce(store, { ...input, operation });
    } catch (error) {
      if (!isTransitionVersionConflict(error)) {
        throw error;
      }
      const fresh = await store.findOperationById(operation.operationId);
      if (!fresh) {
        return operation;
      }
      operation = fresh;
    }
  }

  return operation;
}

export async function applyPlanTransition(
  store: OperationStore,
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
  store: OperationStore,
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
  store: OperationStore,
  operation: PaymentOperation,
  input: {
    subscriptionStatus: SubscriptionStatus;
    reason: string;
    lifecycleReason?: string | null;
    startTime?: string | null;
    nextBillingTime?: string | null;
    providerSubscriptionStateAt?: string | null;
  },
): Promise<PaymentOperation> {
  const current = operation.subscriptionStatus ?? 'approval_pending';
  const resolvedStatus = resolveSubscriptionStatusTransition(current, input.subscriptionStatus);

  const nextExecution = resolveExecutionTransition(
    operation.status,
    subscriptionStatusToOperationStatus(resolvedStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    subscriptionStatus: resolvedStatus,
    lifecycleReason: input.lifecycleReason ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    ...(input.providerSubscriptionStateAt != null
      ? { providerStateWatermark: input.providerSubscriptionStateAt }
      : {}),
    reason: input.reason,
  });
}
