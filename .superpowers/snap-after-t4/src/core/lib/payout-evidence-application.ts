import type { PaymentOperation, PayoutFinancialStatus } from '../../contracts/index';
import {
  assertPayoutFinancialTransitionAllowed,
  deriveBatchPayoutStatus,
  payoutFinancialStatusToOperationStatus,
} from './payout-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import { assertTransitionAllowed } from './transition-policy';
import { persistValidatedPayoutProviderIds } from './payout-webhook-correlation';

export type ApplyPayoutTransitionInput = {
  operation: PaymentOperation;
  payoutStatus: PayoutFinancialStatus;
  evidenceId?: string | null;
  reason: string;
  providerReferenceId?: string | null;
  providerPayoutBatchId?: string | null;
  providerPayoutItemId?: string | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
};

export type ApplyPayoutTransitionResult = {
  operation: PaymentOperation;
  applied: boolean;
};

function isDuplicatePayoutEvidence(
  operation: PaymentOperation,
  payoutStatus: PayoutFinancialStatus,
): boolean {
  const currentPayout = operation.payoutStatus ?? 'pending';
  const nextExecution = payoutFinancialStatusToOperationStatus(payoutStatus);
  return currentPayout === payoutStatus && operation.status === nextExecution;
}

export function isPayoutFinancialTransitionRejected(
  current: PayoutFinancialStatus,
  next: PayoutFinancialStatus,
): boolean {
  try {
    assertPayoutFinancialTransitionAllowed(current, next);
    return false;
  } catch {
    return true;
  }
}

export async function applyPayoutTransition(
  store: PaymentReliabilityStore,
  input: ApplyPayoutTransitionInput,
): Promise<ApplyPayoutTransitionResult> {
  const { operation, payoutStatus } = input;

  if (isDuplicatePayoutEvidence(operation, payoutStatus)) {
    const persisted = await persistValidatedPayoutProviderIds(store, operation, input);
    return { operation: persisted, applied: false };
  }

  const currentPayout = operation.payoutStatus ?? 'pending';
  if (isPayoutFinancialTransitionRejected(currentPayout, payoutStatus)) {
    const persisted = await persistValidatedPayoutProviderIds(store, operation, input);
    return { operation: persisted, applied: false };
  }

  const desiredExecution = payoutFinancialStatusToOperationStatus(payoutStatus);
  let nextExecution = operation.status;
  if (desiredExecution !== operation.status) {
    try {
      assertTransitionAllowed(operation.status, desiredExecution);
      nextExecution = desiredExecution;
    } catch {
      if (
        operation.status === 'succeeded' &&
        (payoutStatus === 'returned' || payoutStatus === 'refunded')
      ) {
        nextExecution = operation.status;
      } else {
        const persisted = await persistValidatedPayoutProviderIds(store, operation, input);
        return { operation: persisted, applied: false };
      }
    }
  }

  const updated = await store.transitionOperation({
    operationId: operation.operationId,
    expectedVersion: operation.version,
    nextStatus: nextExecution,
    payoutStatus,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerPayoutBatchId: input.providerPayoutBatchId ?? undefined,
    providerPayoutItemId: input.providerPayoutItemId ?? undefined,
    providerTransactionId: input.providerTransactionId ?? undefined,
    providerFeeMinor: input.providerFeeMinor ?? undefined,
    providerFeeCurrency: input.providerFeeCurrency ?? undefined,
    failureCode: input.failureCode ?? undefined,
    failureMessage: input.failureMessage ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
  return { operation: updated, applied: true };
}

export async function refreshPayoutBatchAggregate(
  store: PaymentReliabilityStore,
  batch: PaymentOperation,
  evidenceId?: string | null,
  reason = 'Derived payout batch aggregate status',
): Promise<PaymentOperation> {
  const items = (await store.listOperationsByParent(batch.operationId)).filter(
    (row) => row.kind === 'payout_item',
  );
  const aggregate = deriveBatchPayoutStatus(items.map((row) => row.payoutStatus ?? 'pending'));
  if (batch.payoutStatus === aggregate) {
    return batch;
  }
  return store.transitionOperation({
    operationId: batch.operationId,
    expectedVersion: batch.version,
    nextStatus: batch.status,
    payoutStatus: aggregate,
    evidenceId: evidenceId ?? null,
    reason,
  });
}
