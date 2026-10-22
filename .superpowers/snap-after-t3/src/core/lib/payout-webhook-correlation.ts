import type { PaymentOperation } from '../../contracts/index';
import { majorUnitsToMinorString } from './money';
import type { PayoutFinancialStatus } from '../../contracts/index';
import { mapPayoutWebhookEventToOperationKind } from './payout-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';

export type ParsedPaypalPayoutWebhook = {
  payoutScope: 'payout_batch' | 'payout_item';
  providerPayoutBatchId: string | null;
  providerPayoutItemId: string | null;
  senderBatchId: string | null;
  senderItemId: string | null;
  amountMinor: string | null;
  currencyCode: string | null;
  recipientValue: string | null;
  providerTransactionId: string | null;
  providerFeeMinor: string | null;
  providerFeeCurrency: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  canonicalResourceId: string | null;
};

export type PayoutEvidenceCorrelationContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: 'sandbox' | 'live';
  eventType: string | null;
  resourceId: string | null;
  rawPayload: string;
};

export type PayoutCorrelationResult = {
  operation: PaymentOperation;
  parsed: ParsedPaypalPayoutWebhook;
  matchKind: 'primary' | 'fallback';
};

export function isPaypalWebhookEnvelopeId(resourceId: string | null | undefined): boolean {
  return typeof resourceId === 'string' && resourceId.startsWith('WH-');
}

export function parsePaypalPayoutWebhookPayload(
  rawPayload: string,
  eventType: string | null,
): ParsedPaypalPayoutWebhook | null {
  const payoutScope = eventType ? mapPayoutWebhookEventToOperationKind(eventType) : null;
  if (!payoutScope) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as {
      resource?: {
        batch_header?: {
          payout_batch_id?: string;
          sender_batch_header?: { sender_batch_id?: string };
        };
        payout_batch_id?: string;
        payout_item_id?: string;
        sender_item_id?: string;
        transaction_id?: string;
        payout_item?: {
          amount?: { currency?: string; value?: string };
          receiver?: string;
          sender_item_id?: string;
        };
        payout_item_fee?: { currency?: string; value?: string };
        errors?: { name?: string; message?: string };
      };
    };
    const resource = parsed.resource;
    if (!resource) {
      return null;
    }

    if (payoutScope === 'payout_batch') {
      const providerPayoutBatchId = resource.batch_header?.payout_batch_id?.trim() || null;
      const senderBatchId =
        resource.batch_header?.sender_batch_header?.sender_batch_id?.trim() || null;
      return {
        payoutScope,
        providerPayoutBatchId,
        providerPayoutItemId: null,
        senderBatchId,
        senderItemId: null,
        amountMinor: null,
        currencyCode: null,
        recipientValue: null,
        providerTransactionId: null,
        providerFeeMinor: null,
        providerFeeCurrency: null,
        failureCode: resource.errors?.name ?? null,
        failureMessage: resource.errors?.message ?? null,
        canonicalResourceId: providerPayoutBatchId,
      };
    }

    const providerPayoutItemId = resource.payout_item_id?.trim() || null;
    const providerPayoutBatchId = resource.payout_batch_id?.trim() || null;
    const senderItemId =
      resource.sender_item_id?.trim() || resource.payout_item?.sender_item_id?.trim() || null;
    const amount = resource.payout_item?.amount;
    const currencyCode = amount?.currency?.trim().toUpperCase() || null;
    const amountMinor =
      amount?.value && currencyCode ? majorUnitsToMinorString(amount.value, currencyCode) : null;
    const fee = resource.payout_item_fee;
    const providerFeeCurrency = fee?.currency?.trim().toUpperCase() || null;
    const providerFeeMinor =
      fee?.value && providerFeeCurrency
        ? majorUnitsToMinorString(fee.value, providerFeeCurrency)
        : null;

    return {
      payoutScope,
      providerPayoutBatchId,
      providerPayoutItemId,
      senderBatchId: null,
      senderItemId,
      amountMinor,
      currencyCode,
      recipientValue: resource.payout_item?.receiver?.trim() || null,
      providerTransactionId: resource.transaction_id?.trim() || null,
      providerFeeMinor,
      providerFeeCurrency,
      failureCode: resource.errors?.name ?? null,
      failureMessage: resource.errors?.message ?? null,
      canonicalResourceId: providerPayoutItemId,
    };
  } catch {
    return null;
  }
}

function normalizeRecipient(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase();
}

export async function validatePayoutEvidenceMatch(
  store: PaymentReliabilityStore,
  operation: PaymentOperation,
  parsed: ParsedPaypalPayoutWebhook,
  evidence: Pick<PayoutEvidenceCorrelationContext, 'applicationRef'>,
): Promise<boolean> {
  if (operation.applicationRef !== evidence.applicationRef) {
    return false;
  }
  if (operation.kind !== parsed.payoutScope) {
    return false;
  }

  if (parsed.payoutScope === 'payout_batch') {
    if (
      parsed.senderBatchId &&
      operation.senderBatchId &&
      operation.senderBatchId !== parsed.senderBatchId
    ) {
      return false;
    }
    if (
      operation.providerPayoutBatchId &&
      parsed.providerPayoutBatchId &&
      operation.providerPayoutBatchId !== parsed.providerPayoutBatchId
    ) {
      return false;
    }
    return true;
  }

  if (
    parsed.senderItemId &&
    operation.senderItemId &&
    operation.senderItemId !== parsed.senderItemId
  ) {
    return false;
  }
  if (
    operation.providerPayoutItemId &&
    parsed.providerPayoutItemId &&
    operation.providerPayoutItemId !== parsed.providerPayoutItemId
  ) {
    return false;
  }
  if (parsed.amountMinor && operation.amountMinor && operation.amountMinor !== parsed.amountMinor) {
    return false;
  }
  if (
    parsed.currencyCode &&
    operation.currencyCode &&
    operation.currencyCode.toUpperCase() !== parsed.currencyCode
  ) {
    return false;
  }
  const expectedRecipient = normalizeRecipient(operation.recipientValue);
  const incomingRecipient = normalizeRecipient(parsed.recipientValue);
  if (expectedRecipient && incomingRecipient && expectedRecipient !== incomingRecipient) {
    return false;
  }

  if (parsed.providerPayoutBatchId && operation.parentOperationId) {
    const batch = await store.findOperationById(operation.parentOperationId);
    if (!batch || batch.kind !== 'payout_batch') {
      return false;
    }
    if (
      batch.providerPayoutBatchId &&
      batch.providerPayoutBatchId !== parsed.providerPayoutBatchId
    ) {
      return false;
    }
  }

  return true;
}

async function findPrimaryPayoutOperation(
  store: PaymentReliabilityStore,
  context: Pick<PayoutEvidenceCorrelationContext, 'providerCode' | 'accountRef' | 'environment'>,
  parsed: ParsedPaypalPayoutWebhook,
): Promise<PaymentOperation | null> {
  if (parsed.payoutScope === 'payout_batch' && parsed.providerPayoutBatchId) {
    return store.findOperationByProviderPayoutBatchId(
      context.providerCode,
      context.accountRef,
      context.environment,
      parsed.providerPayoutBatchId,
    );
  }
  if (parsed.payoutScope === 'payout_item' && parsed.providerPayoutItemId) {
    return store.findOperationByProviderPayoutItemId(
      context.providerCode,
      context.accountRef,
      context.environment,
      parsed.providerPayoutItemId,
    );
  }
  return null;
}

async function findFallbackPayoutOperation(
  store: PaymentReliabilityStore,
  context: Pick<PayoutEvidenceCorrelationContext, 'providerCode' | 'accountRef' | 'environment'>,
  parsed: ParsedPaypalPayoutWebhook,
): Promise<PaymentOperation | null> {
  if (parsed.payoutScope === 'payout_batch' && parsed.senderBatchId) {
    return store.findOperationBySenderBatchId(
      context.providerCode,
      context.accountRef,
      context.environment,
      parsed.senderBatchId,
    );
  }
  if (parsed.payoutScope === 'payout_item' && parsed.senderItemId) {
    return store.findOperationBySenderItemId(
      context.providerCode,
      context.accountRef,
      context.environment,
      parsed.senderItemId,
    );
  }
  return null;
}

export async function correlatePayoutOperation(
  store: PaymentReliabilityStore,
  evidence: PayoutEvidenceCorrelationContext,
): Promise<PayoutCorrelationResult | null> {
  const parsed = parsePaypalPayoutWebhookPayload(evidence.rawPayload, evidence.eventType);
  if (!parsed) {
    return null;
  }

  if (!isPaypalWebhookEnvelopeId(evidence.resourceId) && evidence.resourceId) {
    if (parsed.payoutScope === 'payout_batch' && !parsed.providerPayoutBatchId) {
      parsed.providerPayoutBatchId = evidence.resourceId;
      parsed.canonicalResourceId = evidence.resourceId;
    }
    if (parsed.payoutScope === 'payout_item' && !parsed.providerPayoutItemId) {
      parsed.providerPayoutItemId = evidence.resourceId;
      parsed.canonicalResourceId = evidence.resourceId;
    }
  }

  const primary = await findPrimaryPayoutOperation(store, evidence, parsed);
  if (primary) {
    if (!(await validatePayoutEvidenceMatch(store, primary, parsed, evidence))) {
      return null;
    }
    return { operation: primary, parsed, matchKind: 'primary' };
  }

  const fallback = await findFallbackPayoutOperation(store, evidence, parsed);
  if (!fallback) {
    return null;
  }
  if (!(await validatePayoutEvidenceMatch(store, fallback, parsed, evidence))) {
    return null;
  }
  return { operation: fallback, parsed, matchKind: 'fallback' };
}

export type PersistValidatedPayoutProviderIdsInput = {
  providerPayoutBatchId?: string | null;
  providerPayoutItemId?: string | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
};

export async function persistValidatedPayoutProviderIds(
  store: PaymentReliabilityStore,
  operation: PaymentOperation,
  ids: PersistValidatedPayoutProviderIdsInput,
  allowRetry = true,
): Promise<PaymentOperation> {
  if (
    ids.providerPayoutItemId &&
    operation.providerPayoutItemId &&
    operation.providerPayoutItemId !== ids.providerPayoutItemId
  ) {
    return operation;
  }
  if (
    ids.providerPayoutBatchId &&
    operation.providerPayoutBatchId &&
    operation.providerPayoutBatchId !== ids.providerPayoutBatchId
  ) {
    return operation;
  }

  const patch: PersistValidatedPayoutProviderIdsInput = {};
  if (ids.providerPayoutBatchId && !operation.providerPayoutBatchId) {
    patch.providerPayoutBatchId = ids.providerPayoutBatchId;
  }
  if (ids.providerPayoutItemId && !operation.providerPayoutItemId) {
    patch.providerPayoutItemId = ids.providerPayoutItemId;
  }
  if (ids.providerTransactionId && !operation.providerTransactionId) {
    patch.providerTransactionId = ids.providerTransactionId;
  }

  if (Object.keys(patch).length === 0) {
    return operation;
  }

  try {
    return await store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      providerPayoutBatchId: patch.providerPayoutBatchId,
      providerPayoutItemId: patch.providerPayoutItemId,
      providerTransactionId: patch.providerTransactionId,
    });
  } catch {
    if (!allowRetry) {
      return operation;
    }
    const reloaded = await store.findOperationById(operation.operationId);
    if (!reloaded) {
      return operation;
    }
    return persistValidatedPayoutProviderIds(store, reloaded, ids, false);
  }
}

export function buildPayoutTransitionProviderFields(
  operation: PaymentOperation,
  parsed: ParsedPaypalPayoutWebhook,
  payoutFinancialStatus: PayoutFinancialStatus,
): PersistValidatedPayoutProviderIdsInput & {
  providerReferenceId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
} {
  const includeFee = payoutFinancialStatus === 'succeeded';
  return {
    providerReferenceId: parsed.canonicalResourceId,
    providerPayoutBatchId:
      parsed.payoutScope === 'payout_batch' ? parsed.providerPayoutBatchId : undefined,
    providerPayoutItemId:
      parsed.payoutScope === 'payout_item' ? parsed.providerPayoutItemId : undefined,
    providerTransactionId: parsed.providerTransactionId,
    providerFeeMinor: includeFee ? parsed.providerFeeMinor : undefined,
    providerFeeCurrency: includeFee ? parsed.providerFeeCurrency : undefined,
    failureCode: parsed.failureCode,
    failureMessage: parsed.failureMessage,
  };
}
