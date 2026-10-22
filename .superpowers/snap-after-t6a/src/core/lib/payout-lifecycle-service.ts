import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CancelUnclaimedPayoutItemRequest,
  type CancelUnclaimedPayoutItemResult,
  type GetPayoutBatchRequest,
  type GetPayoutBatchResult,
  type GetPayoutItemRequest,
  type GetPayoutItemResult,
  type PaymentOperation,
  type PayoutBatchItemResult,
  type PayoutFinancialStatus,
  type SubmitPayoutBatchRequest,
  type SubmitPayoutBatchResult,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import { maskRecipientValue } from './mask-recipient';
import { validateCanonicalMoney } from './money';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import type { PayoutProviderPort } from './payout-provider-port';
import { buildPaypalSenderId } from './payout-sender-id';
import {
  isTerminalPreProviderFailureCode,
  resolveProviderFailure,
} from './resolve-provider-failure';
import {
  deriveBatchPayoutStatus,
  payoutFinancialStatusToOperationStatus,
} from './payout-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';

function isExecutionTerminal(status: PaymentOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

function totalsByCurrency(items: PaymentOperation[]): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const item of items) {
    if (!item.currencyCode || !item.amountMinor) continue;
    const current = totals.get(item.currencyCode) ?? 0n;
    totals.set(item.currencyCode, current + BigInt(item.amountMinor));
  }
  return Object.fromEntries(
    [...totals.entries()].map(([currency, minor]) => [currency, minor.toString()]),
  );
}

function toItemResult(operation: PaymentOperation): PayoutBatchItemResult {
  return {
    itemOperationId: operation.operationId,
    itemRef: operation.itemRef ?? '',
    operationStatus: operation.status,
    payoutStatus: operation.payoutStatus ?? 'pending',
    senderItemId: operation.senderItemId ?? '',
    providerPayoutItemId: operation.providerPayoutItemId,
    amount: {
      currency: operation.currencyCode ?? 'USD',
      amountMinor: operation.amountMinor ?? '0',
    },
    maskedDestination: operation.maskedDestination ?? '***',
    providerTransactionId: operation.providerTransactionId,
    providerFee:
      operation.providerFeeMinor && operation.providerFeeCurrency
        ? {
            currency: operation.providerFeeCurrency,
            amountMinor: operation.providerFeeMinor,
          }
        : null,
    failureCode: operation.failureCode,
    failureMessage: operation.failureMessage,
  };
}

function toBatchResult(
  batch: PaymentOperation,
  items: PaymentOperation[],
): SubmitPayoutBatchResult {
  return {
    batchOperationId: batch.operationId,
    operationStatus: batch.status,
    payoutStatus: batch.payoutStatus ?? 'accepted',
    senderBatchId: batch.senderBatchId ?? '',
    providerPayoutBatchId: batch.providerPayoutBatchId,
    itemCount: items.length,
    totalsByCurrency: totalsByCurrency(items),
    items: items.map(toItemResult),
    correlationId: batch.correlationId,
  };
}

export class PayoutLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: PayoutProviderPort,
  ) {}

  async submitPayoutBatch(input: SubmitPayoutBatchRequest): Promise<SubmitPayoutBatchResult> {
    if (!input.items.length) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Payout batch must contain at least one item',
      );
    }

    const itemRefs = new Set<string>();
    for (const item of input.items) {
      if (itemRefs.has(item.itemRef)) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Duplicate payout item identity in batch',
        );
      }
      itemRefs.add(item.itemRef);
      validateCanonicalMoney(item.amount);
    }

    const sortedItems = [...input.items].sort((a, b) => a.itemRef.localeCompare(b.itemRef));
    const fingerprint = buildCommandFingerprint({
      items: sortedItems.map((item) => ({
        itemRef: item.itemRef,
        amount: item.amount,
        recipientType: item.recipient.recipientType,
        receiver: item.recipient.receiver,
        note: item.recipient.note ?? null,
        purpose: item.recipient.purpose ?? null,
      })),
      emailSubject: input.emailSubject ?? null,
      emailMessage: input.emailMessage ?? null,
    });

    const batchScope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'payout_batch',
    });

    let batchOp = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: batchScope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'payout_batch',
      correlationId: input.correlationId ?? null,
      payoutStatus: 'accepted',
    });

    const itemOps: PaymentOperation[] = [];
    for (const item of sortedItems) {
      const amount = validateCanonicalMoney(item.amount);
      const itemScope = buildOperationIdempotencyScope({
        applicationRef: input.applicationRef,
        accountRef: input.accountRef,
        environment: input.environment,
        kind: 'payout_item',
      });
      const itemOp = await this.store.createOperation({
        idempotencyKey: `${input.idempotencyKey}::${item.itemRef}`,
        idempotencyScope: itemScope,
        commandFingerprint: buildCommandFingerprint({
          itemRef: item.itemRef,
          batchFingerprint: fingerprint,
        }),
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        kind: 'payout_item',
        correlationId: input.correlationId ?? null,
        parentOperationId: batchOp.operationId,
        amountMinor: amount.amountMinor,
        currencyCode: amount.currency,
        itemRef: item.itemRef,
        recipientType: item.recipient.recipientType,
        recipientValue: item.recipient.receiver,
        maskedDestination: maskRecipientValue(
          item.recipient.recipientType,
          item.recipient.receiver,
        ),
        payoutStatus: 'pending',
        senderItemId: buildPaypalSenderId('item', `${batchOp.operationId}:${item.itemRef}`),
      });
      itemOps.push(itemOp);
    }

    const reloadItems = async () =>
      (await this.store.listOperationsByParent(batchOp.operationId)).filter(
        (row) => row.kind === 'payout_item',
      );

    if (isExecutionTerminal(batchOp.status)) {
      return toBatchResult(batchOp, await reloadItems());
    }
    if (batchOp.status === 'submitted' || batchOp.status === 'unknown') {
      return toBatchResult(batchOp, await reloadItems());
    }

    const senderBatchId = buildPaypalSenderId('batch', batchOp.operationId);
    batchOp = await this.store.transitionOperation({
      operationId: batchOp.operationId,
      expectedVersion: batchOp.version,
      nextStatus: 'submitted',
      senderBatchId,
      payoutStatus: 'accepted',
      reason: 'Payout batch claimed for provider submission',
    });

    for (let index = 0; index < itemOps.length; index += 1) {
      const itemOp = itemOps[index];
      if (!itemOp) continue;
      if (itemOp.status === 'prepared') {
        itemOps[index] = await this.store.claimOperationForExecution({
          operationId: itemOp.operationId,
          expectedVersion: itemOp.version,
        });
      }
    }

    try {
      const providerResult = await this.provider.submitBatch({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: batchOp.operationId,
        senderBatchId,
        emailSubject: input.emailSubject ?? null,
        emailMessage: input.emailMessage ?? null,
        items: sortedItems.map((item, index) => ({
          senderItemId:
            itemOps[index]?.senderItemId ??
            buildPaypalSenderId('item', `${batchOp.operationId}:${item.itemRef}`),
          amount: validateCanonicalMoney(item.amount),
          recipientType: item.recipient.recipientType,
          receiver: item.recipient.receiver,
          note: item.recipient.note ?? null,
          purpose: item.recipient.purpose ?? null,
        })),
      });

      batchOp = await this.store.transitionOperation({
        operationId: batchOp.operationId,
        expectedVersion: batchOp.version,
        nextStatus: payoutFinancialStatusToOperationStatus(providerResult.batchPayoutStatus),
        providerReferenceId: providerResult.providerPayoutBatchId,
        providerPayoutBatchId: providerResult.providerPayoutBatchId,
        senderBatchId,
        payoutStatus: providerResult.batchPayoutStatus,
        reason: 'PayPal accepted payout batch for processing',
      });

      for (let index = 0; index < itemOps.length; index += 1) {
        const itemOp = itemOps[index];
        if (!itemOp) continue;
        const providerItem = providerResult.items.find(
          (row) => row.senderItemId === itemOp.senderItemId,
        );
        const payoutStatus: PayoutFinancialStatus = providerItem?.payoutStatus ?? 'pending';
        itemOps[index] = await this.store.transitionOperation({
          operationId: itemOp.operationId,
          expectedVersion: itemOp.version,
          nextStatus: payoutFinancialStatusToOperationStatus(payoutStatus),
          providerPayoutItemId: providerItem?.providerPayoutItemId ?? null,
          providerReferenceId: providerItem?.providerPayoutItemId ?? itemOp.providerReferenceId,
          providerTransactionId: providerItem?.providerTransactionId ?? null,
          providerFeeMinor: providerItem?.providerFee?.amountMinor ?? null,
          providerFeeCurrency: providerItem?.providerFee?.currency ?? null,
          payoutStatus,
          failureCode: providerItem?.failureCode ?? null,
          failureMessage: providerItem?.failureMessage ?? null,
          reason: 'PayPal recorded payout item submission outcome',
        });
      }

      const aggregate = deriveBatchPayoutStatus(
        itemOps.map((row) => row.payoutStatus ?? 'pending'),
      );
      batchOp = await this.store.transitionOperation({
        operationId: batchOp.operationId,
        expectedVersion: batchOp.version,
        nextStatus: batchOp.status,
        payoutStatus: aggregate,
        reason: 'Derived payout batch aggregate status',
      });
    } catch (error) {
      batchOp = await this.handleProviderFailure(batchOp, error);
      for (const itemOp of itemOps) {
        if (!isExecutionTerminal(itemOp.status)) {
          const updated = await this.store.transitionOperation({
            operationId: itemOp.operationId,
            expectedVersion: itemOp.version,
            nextStatus: batchOp.status,
            payoutStatus: batchOp.payoutStatus ?? 'unknown',
            failureCode: batchOp.failureCode,
            failureMessage: batchOp.failureMessage,
            reason: 'Payout batch submission failed or became uncertain',
          });
          const idx = itemOps.findIndex((row) => row.operationId === updated.operationId);
          if (idx >= 0) itemOps[idx] = updated;
        }
      }
    }

    return toBatchResult(batchOp, itemOps);
  }

  async getPayoutBatch(input: GetPayoutBatchRequest): Promise<GetPayoutBatchResult> {
    const batch = await this.store.findOperationById(input.batchOperationId);
    if (!batch || batch.kind !== 'payout_batch') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Payout batch operation was not found',
      );
    }
    const items = await this.store.listOperationsByParent(batch.operationId);
    return toBatchResult(
      batch,
      items.filter((row) => row.kind === 'payout_item'),
    );
  }

  async getPayoutItem(input: GetPayoutItemRequest): Promise<GetPayoutItemResult> {
    const item = await this.store.findOperationById(input.itemOperationId);
    if (!item || item.kind !== 'payout_item' || !item.parentOperationId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Payout item operation was not found',
      );
    }
    const batch = await this.store.findOperationById(item.parentOperationId);
    if (!batch) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Parent payout batch was not found',
      );
    }
    return {
      ...toItemResult(item),
      batchOperationId: batch.operationId,
      senderBatchId: batch.senderBatchId ?? '',
      providerPayoutBatchId: batch.providerPayoutBatchId,
      correlationId: item.correlationId,
    };
  }

  async cancelUnclaimedPayoutItem(
    input: CancelUnclaimedPayoutItemRequest,
  ): Promise<CancelUnclaimedPayoutItemResult> {
    const item = await this.store.findOperationById(input.itemOperationId);
    if (!item || item.kind !== 'payout_item' || !item.providerPayoutItemId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Unclaimed payout item with provider reference was not found',
      );
    }
    if (item.payoutStatus !== 'unclaimed') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Only unclaimed payout items can be cancelled',
      );
    }

    const providerResult = await this.provider.cancelUnclaimedItem({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerPayoutItemId: item.providerPayoutItemId,
    });

    const updated = await this.store.transitionOperation({
      operationId: item.operationId,
      expectedVersion: item.version,
      nextStatus: payoutFinancialStatusToOperationStatus(providerResult.payoutStatus),
      payoutStatus: providerResult.payoutStatus,
      providerTransactionId: providerResult.providerTransactionId,
      providerFeeMinor: providerResult.providerFee?.amountMinor ?? null,
      providerFeeCurrency: providerResult.providerFee?.currency ?? null,
      failureCode: providerResult.failureCode,
      failureMessage: providerResult.failureMessage,
      reason: 'PayPal cancelled unclaimed payout item',
    });

    return this.getPayoutItem({ ...input, itemOperationId: updated.operationId });
  }

  private async handleProviderFailure(
    operation: PaymentOperation,
    error: unknown,
  ): Promise<PaymentOperation> {
    const resolved = resolveProviderFailure(error);
    const nextStatus =
      resolved.uncertain || resolved.retryable
        ? 'unknown'
        : isTerminalPreProviderFailureCode(resolved.code) ||
            resolved.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION
          ? 'failed'
          : 'unknown';

    return this.store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus,
      payoutStatus: nextStatus === 'unknown' ? 'unknown' : 'failed',
      failureCode: resolved.code,
      failureMessage: resolved.message,
      reason: 'Payout provider submission returned uncertain or terminal outcome',
    });
  }
}
