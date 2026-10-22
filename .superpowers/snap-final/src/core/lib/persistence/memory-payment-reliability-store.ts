import { randomUUID } from 'node:crypto';
import { checkoutCreateExecutionLeaseExpiresAt } from '../checkout-create-execution-lease';
import type {
  AcquireCheckoutCreateExecutionLeaseResult,
  ReviveUnmatchedEvidenceInput,
} from './payment-reliability-store';
import {
  DEFAULT_SUBMITTED_STALE_KINDS,
  OPERATION_TRANSITION_KIND,
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_RPC_TRANSITION_DETAIL,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
  type CreatePaymentOperationInput,
  type InsertProviderEvidenceInput,
  type InsertReconciliationAttemptInput,
  type PaymentOperation,
  type PaymentOperationTransitionRecord,
  type ProviderEvidenceRecord,
  type ReconciliationAttempt,
  type TransitionPaymentOperationInput,
  type UpdatePaymentOperationInput,
  type UpdateProviderEvidenceInput,
  type CreateSellerConnectionInput,
  type InsertMarketplacePurchaseUnitInput,
  type MarketplacePurchaseUnitRecord,
  type SellerConnectionRecord,
  type UpdateMarketplacePurchaseUnitInput,
  type UpdateSellerConnectionInput,
  type ClaimPendingEvidenceInput,
  type ListPaymentEvidenceForRecoveryInput,
  type ListPaymentEvidenceForRecoveryResult,
  type PaymentEvidenceAdminView,
  type ListUncertainOperationsOptions,
} from '../../../contracts/index';
import { CLEARED_RETRY_STATE, hasRetryState, isRetryDue } from '../retry-backoff';
import { sha256Payload } from '../sha256-payload';
import { assertTransitionAllowed } from '../transition-policy';
import {
  isAwaitingConsumerDeliveryOnly,
  isRecoverableEvidenceRow,
} from '../webhook-evidence-resume';
import type { PaymentReliabilityStore } from './payment-reliability-store';

function nowIso(): string {
  return new Date().toISOString();
}

/** `ORDER BY COALESCE(next_attempt_at, received_at), evidence_id`. */
function byNextAttemptAt(left: ProviderEvidenceRecord, right: ProviderEvidenceRecord): number {
  return (
    compareIsoTimes(
      left.nextAttemptAt ?? left.receivedAt,
      right.nextAttemptAt ?? right.receivedAt,
    ) || left.evidenceId.localeCompare(right.evidenceId)
  );
}

/** `ORDER BY COALESCE(next_attempt_at, created_at), operation_id`. */
function operationsByNextAttemptAt(left: PaymentOperation, right: PaymentOperation): number {
  return (
    compareIsoTimes(left.nextAttemptAt ?? left.createdAt, right.nextAttemptAt ?? right.createdAt) ||
    left.operationId.localeCompare(right.operationId)
  );
}

/** Compares instants, so `nextAttemptAt` written with another offset or precision still sorts. */
function compareIsoTimes(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  return Number.isFinite(difference) ? Math.sign(difference) : left.localeCompare(right);
}

export class MemoryPaymentReliabilityStore implements PaymentReliabilityStore {
  private readonly operations = new Map<string, PaymentOperation>();
  private readonly operationsByIdempotency = new Map<string, PaymentOperation>();
  private readonly operationsByProviderRef = new Map<string, PaymentOperation>();
  private readonly operationsByProviderOrderId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderCaptureId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderRefundId = new Map<string, PaymentOperation>();
  private readonly operationsBySenderBatchId = new Map<string, PaymentOperation>();
  private readonly operationsBySenderItemId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderPayoutBatchId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderPayoutItemId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderProductId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderPlanId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderSubscriptionId = new Map<string, PaymentOperation>();
  private readonly operationsByProviderReferralId = new Map<string, PaymentOperation>();
  private readonly evidence = new Map<string, ProviderEvidenceRecord>();
  private readonly evidenceByProviderEvent = new Map<string, ProviderEvidenceRecord>();
  private readonly transitions: PaymentOperationTransitionRecord[] = [];
  private readonly reconciliationAttempts: ReconciliationAttempt[] = [];
  private readonly sellerConnections = new Map<string, SellerConnectionRecord>();
  private readonly marketplaceUnits = new Map<string, MarketplacePurchaseUnitRecord>();
  private readonly marketplaceUnitsByCaptureId = new Map<string, MarketplacePurchaseUnitRecord>();
  /** Index entries each operation occupies, so a cleared or changed provider id stops matching. */
  private readonly operationIndexEntries = new Map<
    string,
    Array<[Map<string, PaymentOperation>, string]>
  >();

  async createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation> {
    const idempotencyKey = `${input.idempotencyScope}::${input.idempotencyKey}`;
    const existing = this.operationsByIdempotency.get(idempotencyKey);
    if (existing) {
      if (existing.commandFingerprint !== input.commandFingerprint) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
          'Idempotency key is already bound to a different command fingerprint',
        );
      }
      return existing;
    }

    const timestamp = nowIso();
    const operation: PaymentOperation = {
      operationId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: input.idempotencyScope,
      commandFingerprint: input.commandFingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerReferenceId: input.providerReferenceId ?? null,
      kind: input.kind,
      status: 'prepared',
      correlationId: input.correlationId ?? null,
      failureCode: null,
      failureMessage: null,
      parentOperationId: input.parentOperationId ?? null,
      approvalUrl: null,
      amountMinor: input.amountMinor ?? null,
      currencyCode: input.currencyCode ?? null,
      providerOrderId: input.providerOrderId ?? null,
      providerCaptureId: input.providerCaptureId ?? null,
      providerRefundId: null,
      senderBatchId: input.senderBatchId ?? null,
      senderItemId: input.senderItemId ?? null,
      providerPayoutBatchId: input.providerPayoutBatchId ?? null,
      providerPayoutItemId: input.providerPayoutItemId ?? null,
      payoutStatus: input.payoutStatus ?? null,
      recipientType: input.recipientType ?? null,
      maskedDestination: input.maskedDestination ?? null,
      recipientValue: input.recipientValue ?? null,
      providerTransactionId: input.providerTransactionId ?? null,
      providerFeeMinor: input.providerFeeMinor ?? null,
      providerFeeCurrency: input.providerFeeCurrency ?? null,
      itemRef: input.itemRef ?? null,
      productStatus: input.productStatus ?? null,
      planStatus: input.planStatus ?? null,
      subscriptionStatus: input.subscriptionStatus ?? null,
      providerProductId: input.providerProductId ?? null,
      providerPlanId: input.providerPlanId ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      offeringRef: input.offeringRef ?? null,
      maskedSubscriber: input.maskedSubscriber ?? null,
      subscriberRef: input.subscriberRef ?? null,
      subscriberEmail: input.subscriberEmail ?? null,
      startTime: input.startTime ?? null,
      nextBillingTime: input.nextBillingTime ?? null,
      lifecycleReason: input.lifecycleReason ?? null,
      providerSubscriptionStateAt: input.providerSubscriptionStateAt ?? null,
      subscriptionStateJson: input.subscriptionStateJson ?? null,
      sellerRef: input.sellerRef ?? null,
      providerReferralId: input.providerReferralId ?? null,
      executionLeaseExpiresAt: input.executionLeaseExpiresAt ?? null,
      executionOwnerToken: input.executionOwnerToken ?? null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.assertProviderIdsUnbound(operation);
    this.operations.set(operation.operationId, operation);
    this.operationsByIdempotency.set(idempotencyKey, operation);
    this.indexOperationReferences(operation);
    return operation;
  }

  async findOperationById(operationId: string): Promise<PaymentOperation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async findOperationByIdempotency(
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PaymentOperation | null> {
    return this.operationsByIdempotency.get(`${idempotencyScope}::${idempotencyKey}`) ?? null;
  }

  async findOperationByProviderReference(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferenceId: string,
  ): Promise<PaymentOperation | null> {
    const key = `${providerCode}::${accountRef}::${environment}::${providerReferenceId}`;
    return this.operationsByProviderRef.get(key) ?? null;
  }

  async findOperationByProviderOrderId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerOrderId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderOrderId.get(
        `${providerCode}::${accountRef}::${environment}::${providerOrderId}`,
      ) ?? null
    );
  }

  async findOperationByProviderCaptureId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerCaptureId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderCaptureId.get(
        `${providerCode}::${accountRef}::${environment}::${providerCaptureId}`,
      ) ?? null
    );
  }

  async findOperationByProviderRefundId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerRefundId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderRefundId.get(
        `${providerCode}::${accountRef}::${environment}::${providerRefundId}`,
      ) ?? null
    );
  }

  async findOperationBySenderBatchId(
    providerCode: string,
    accountRef: string,
    environment: string,
    senderBatchId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsBySenderBatchId.get(
        `${providerCode}::${accountRef}::${environment}::${senderBatchId}`,
      ) ?? null
    );
  }

  async findOperationBySenderItemId(
    providerCode: string,
    accountRef: string,
    environment: string,
    senderItemId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsBySenderItemId.get(
        `${providerCode}::${accountRef}::${environment}::${senderItemId}`,
      ) ?? null
    );
  }

  async findOperationByProviderPayoutBatchId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPayoutBatchId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderPayoutBatchId.get(
        `${providerCode}::${accountRef}::${environment}::${providerPayoutBatchId}`,
      ) ?? null
    );
  }

  async findOperationByProviderPayoutItemId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPayoutItemId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderPayoutItemId.get(
        `${providerCode}::${accountRef}::${environment}::${providerPayoutItemId}`,
      ) ?? null
    );
  }

  async findOperationByProviderProductId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerProductId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderProductId.get(
        `${providerCode}::${accountRef}::${environment}::${providerProductId}`,
      ) ?? null
    );
  }

  async findOperationByProviderPlanId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPlanId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderPlanId.get(
        `${providerCode}::${accountRef}::${environment}::${providerPlanId}`,
      ) ?? null
    );
  }

  async findOperationByProviderSubscriptionId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerSubscriptionId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderSubscriptionId.get(
        `${providerCode}::${accountRef}::${environment}::${providerSubscriptionId}`,
      ) ?? null
    );
  }

  async findOperationByProviderReferralId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferralId: string,
  ): Promise<PaymentOperation | null> {
    return (
      this.operationsByProviderReferralId.get(
        `${providerCode}::${accountRef}::${environment}::${providerReferralId}`,
      ) ?? null
    );
  }

  async claimOperationForExecution(input: {
    operationId: string;
    expectedVersion: number;
  }): Promise<PaymentOperation> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        'Operation was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        'Operation version conflict during claim',
      );
    }
    if (current.status !== 'prepared') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        `Operation is not claimable from status "${current.status}"`,
      );
    }
    return this.transitionOperation({
      operationId: current.operationId,
      expectedVersion: current.version,
      nextStatus: 'submitted',
      reason: 'Claimed for provider execution',
      transitionKind: OPERATION_TRANSITION_KIND.CLAIM_EXECUTION,
    });
  }

  async acquireCheckoutCreateExecutionLease(input: {
    operationId: string;
    expectedVersion: number;
  }): Promise<AcquireCheckoutCreateExecutionLeaseResult> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        'Operation was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      const leaseExpiresMs = current.executionLeaseExpiresAt
        ? Date.parse(current.executionLeaseExpiresAt)
        : Number.NaN;
      if (
        current.executionOwnerToken &&
        Number.isFinite(leaseExpiresMs) &&
        Date.now() < leaseExpiresMs
      ) {
        return { kind: 'in_flight', operation: current };
      }
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        'Operation version conflict during lease acquire',
      );
    }
    if (current.kind !== 'checkout' && current.kind !== 'subscription') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Create execution lease applies only to checkout or subscription operations',
      );
    }
    const hasProviderCreateReference =
      current.kind === 'checkout'
        ? Boolean(current.providerOrderId || current.providerReferenceId)
        : Boolean(current.providerSubscriptionId?.trim());
    if (hasProviderCreateReference) {
      return { kind: 'not_eligible', operation: current };
    }
    if (current.status === 'succeeded' || current.status === 'failed') {
      return { kind: 'not_eligible', operation: current };
    }

    const nowMs = Date.now();
    const leaseExpiresMs = current.executionLeaseExpiresAt
      ? Date.parse(current.executionLeaseExpiresAt)
      : Number.NaN;
    if (current.executionOwnerToken && Number.isFinite(leaseExpiresMs) && nowMs < leaseExpiresMs) {
      return { kind: 'in_flight', operation: current };
    }

    const claimableFromPrepared = current.status === 'prepared';
    const claimableFromUnknown = current.status === 'unknown';
    const claimableFromSubmitted =
      current.status === 'submitted' &&
      (!current.executionOwnerToken || !Number.isFinite(leaseExpiresMs) || nowMs >= leaseExpiresMs);
    if (!claimableFromPrepared && !claimableFromUnknown && !claimableFromSubmitted) {
      return { kind: 'not_eligible', operation: current };
    }

    const executionOwnerToken = randomUUID();
    const executionLeaseExpiresAt = checkoutCreateExecutionLeaseExpiresAt(nowMs);
    const reason =
      current.status === 'prepared'
        ? 'Claimed for provider execution'
        : current.kind === 'subscription'
          ? 'Claimed subscription create retry for provider execution'
          : 'Claimed checkout create retry for provider execution';

    const operation = await this.transitionOperation({
      operationId: current.operationId,
      expectedVersion: current.version,
      nextStatus: 'submitted',
      executionOwnerToken,
      executionLeaseExpiresAt,
      reason,
      transitionKind: claimableFromPrepared
        ? OPERATION_TRANSITION_KIND.CLAIM_EXECUTION
        : OPERATION_TRANSITION_KIND.CLAIM_RETRY,
    });

    return { kind: 'acquired', operation, executionOwnerToken };
  }

  async updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
        'Operation was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Operation version conflict',
      );
    }
    const updated: PaymentOperation = {
      ...current,
      approvalUrl: input.approvalUrl !== undefined ? input.approvalUrl : current.approvalUrl,
      amountMinor: input.amountMinor !== undefined ? input.amountMinor : current.amountMinor,
      currencyCode: input.currencyCode !== undefined ? input.currencyCode : current.currencyCode,
      providerOrderId:
        input.providerOrderId !== undefined ? input.providerOrderId : current.providerOrderId,
      providerCaptureId:
        input.providerCaptureId !== undefined ? input.providerCaptureId : current.providerCaptureId,
      providerRefundId:
        input.providerRefundId !== undefined ? input.providerRefundId : current.providerRefundId,
      providerReferenceId:
        input.providerReferenceId !== undefined
          ? input.providerReferenceId
          : current.providerReferenceId,
      senderBatchId:
        input.senderBatchId !== undefined ? input.senderBatchId : current.senderBatchId,
      senderItemId: input.senderItemId !== undefined ? input.senderItemId : current.senderItemId,
      providerPayoutBatchId:
        input.providerPayoutBatchId !== undefined
          ? input.providerPayoutBatchId
          : current.providerPayoutBatchId,
      providerPayoutItemId:
        input.providerPayoutItemId !== undefined
          ? input.providerPayoutItemId
          : current.providerPayoutItemId,
      payoutStatus: input.payoutStatus !== undefined ? input.payoutStatus : current.payoutStatus,
      recipientType:
        input.recipientType !== undefined ? input.recipientType : current.recipientType,
      maskedDestination:
        input.maskedDestination !== undefined ? input.maskedDestination : current.maskedDestination,
      recipientValue:
        input.recipientValue !== undefined ? input.recipientValue : current.recipientValue,
      providerTransactionId:
        input.providerTransactionId !== undefined
          ? input.providerTransactionId
          : current.providerTransactionId,
      providerFeeMinor:
        input.providerFeeMinor !== undefined ? input.providerFeeMinor : current.providerFeeMinor,
      providerFeeCurrency:
        input.providerFeeCurrency !== undefined
          ? input.providerFeeCurrency
          : current.providerFeeCurrency,
      itemRef: input.itemRef !== undefined ? input.itemRef : current.itemRef,
      productStatus:
        input.productStatus !== undefined ? input.productStatus : current.productStatus,
      planStatus: input.planStatus !== undefined ? input.planStatus : current.planStatus,
      subscriptionStatus:
        input.subscriptionStatus !== undefined
          ? input.subscriptionStatus
          : current.subscriptionStatus,
      providerProductId:
        input.providerProductId !== undefined ? input.providerProductId : current.providerProductId,
      providerPlanId:
        input.providerPlanId !== undefined ? input.providerPlanId : current.providerPlanId,
      providerSubscriptionId:
        input.providerSubscriptionId !== undefined
          ? input.providerSubscriptionId
          : current.providerSubscriptionId,
      offeringRef: input.offeringRef !== undefined ? input.offeringRef : current.offeringRef,
      maskedSubscriber:
        input.maskedSubscriber !== undefined ? input.maskedSubscriber : current.maskedSubscriber,
      subscriberRef:
        input.subscriberRef !== undefined ? input.subscriberRef : current.subscriberRef,
      subscriberEmail:
        input.subscriberEmail !== undefined ? input.subscriberEmail : current.subscriberEmail,
      startTime: input.startTime !== undefined ? input.startTime : current.startTime,
      nextBillingTime:
        input.nextBillingTime !== undefined ? input.nextBillingTime : current.nextBillingTime,
      lifecycleReason:
        input.lifecycleReason !== undefined ? input.lifecycleReason : current.lifecycleReason,
      providerSubscriptionStateAt:
        input.providerSubscriptionStateAt !== undefined
          ? input.providerSubscriptionStateAt
          : current.providerSubscriptionStateAt,
      subscriptionStateJson:
        input.subscriptionStateJson !== undefined
          ? input.subscriptionStateJson
          : (current.subscriptionStateJson ?? null),
      sellerRef: input.sellerRef !== undefined ? input.sellerRef : current.sellerRef,
      providerReferralId:
        input.providerReferralId !== undefined
          ? input.providerReferralId
          : current.providerReferralId,
      attempts: input.attempts !== undefined ? input.attempts : current.attempts,
      nextAttemptAt:
        input.nextAttemptAt !== undefined ? input.nextAttemptAt : current.nextAttemptAt,
      retryStatus: input.retryStatus !== undefined ? input.retryStatus : current.retryStatus,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    this.assertProviderIdsUnbound(updated);
    this.operations.set(updated.operationId, updated);
    this.operationsByIdempotency.set(
      `${updated.idempotencyScope}::${updated.idempotencyKey}`,
      updated,
    );
    this.indexOperationReferences(updated);
    return updated;
  }

  async transitionOperation(input: TransitionPaymentOperationInput): Promise<PaymentOperation> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Operation was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Operation version conflict',
      );
    }

    if (
      input.expectedExecutionOwnerToken != null &&
      input.expectedExecutionOwnerToken !== current.executionOwnerToken
    ) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
        PAYMENT_RPC_TRANSITION_DETAIL.EXECUTION_OWNER_MISMATCH,
        {
          rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH,
        },
      );
    }

    const updated: PaymentOperation = {
      ...current,
      status: input.nextStatus,
      // A transition never unbinds a provider reference: `null` keeps it too.
      providerReferenceId: input.providerReferenceId ?? current.providerReferenceId,
      failureCode: input.failureCode !== undefined ? input.failureCode : current.failureCode,
      failureMessage:
        input.failureMessage !== undefined ? input.failureMessage : current.failureMessage,
      approvalUrl: input.approvalUrl !== undefined ? input.approvalUrl : current.approvalUrl,
      amountMinor: input.amountMinor !== undefined ? input.amountMinor : current.amountMinor,
      currencyCode: input.currencyCode !== undefined ? input.currencyCode : current.currencyCode,
      providerOrderId:
        input.providerOrderId !== undefined ? input.providerOrderId : current.providerOrderId,
      providerCaptureId:
        input.providerCaptureId !== undefined ? input.providerCaptureId : current.providerCaptureId,
      providerRefundId:
        input.providerRefundId !== undefined ? input.providerRefundId : current.providerRefundId,
      senderBatchId:
        input.senderBatchId !== undefined ? input.senderBatchId : current.senderBatchId,
      senderItemId: input.senderItemId !== undefined ? input.senderItemId : current.senderItemId,
      providerPayoutBatchId:
        input.providerPayoutBatchId !== undefined
          ? input.providerPayoutBatchId
          : current.providerPayoutBatchId,
      providerPayoutItemId:
        input.providerPayoutItemId !== undefined
          ? input.providerPayoutItemId
          : current.providerPayoutItemId,
      payoutStatus: input.payoutStatus !== undefined ? input.payoutStatus : current.payoutStatus,
      recipientType:
        input.recipientType !== undefined ? input.recipientType : current.recipientType,
      maskedDestination:
        input.maskedDestination !== undefined ? input.maskedDestination : current.maskedDestination,
      recipientValue:
        input.recipientValue !== undefined ? input.recipientValue : current.recipientValue,
      providerTransactionId:
        input.providerTransactionId !== undefined
          ? input.providerTransactionId
          : current.providerTransactionId,
      providerFeeMinor:
        input.providerFeeMinor !== undefined ? input.providerFeeMinor : current.providerFeeMinor,
      providerFeeCurrency:
        input.providerFeeCurrency !== undefined
          ? input.providerFeeCurrency
          : current.providerFeeCurrency,
      itemRef: input.itemRef !== undefined ? input.itemRef : current.itemRef,
      productStatus:
        input.productStatus !== undefined ? input.productStatus : current.productStatus,
      planStatus: input.planStatus !== undefined ? input.planStatus : current.planStatus,
      subscriptionStatus:
        input.subscriptionStatus !== undefined
          ? input.subscriptionStatus
          : current.subscriptionStatus,
      providerProductId:
        input.providerProductId !== undefined ? input.providerProductId : current.providerProductId,
      providerPlanId:
        input.providerPlanId !== undefined ? input.providerPlanId : current.providerPlanId,
      providerSubscriptionId:
        input.providerSubscriptionId !== undefined
          ? input.providerSubscriptionId
          : current.providerSubscriptionId,
      offeringRef: input.offeringRef !== undefined ? input.offeringRef : current.offeringRef,
      maskedSubscriber:
        input.maskedSubscriber !== undefined ? input.maskedSubscriber : current.maskedSubscriber,
      subscriberRef:
        input.subscriberRef !== undefined ? input.subscriberRef : current.subscriberRef,
      subscriberEmail:
        input.subscriberEmail !== undefined ? input.subscriberEmail : current.subscriberEmail,
      startTime: input.startTime !== undefined ? input.startTime : current.startTime,
      nextBillingTime:
        input.nextBillingTime !== undefined ? input.nextBillingTime : current.nextBillingTime,
      lifecycleReason:
        input.lifecycleReason !== undefined ? input.lifecycleReason : current.lifecycleReason,
      providerSubscriptionStateAt:
        input.providerSubscriptionStateAt !== undefined
          ? input.providerSubscriptionStateAt
          : current.providerSubscriptionStateAt,
      subscriptionStateJson:
        input.subscriptionStateJson !== undefined
          ? input.subscriptionStateJson
          : (current.subscriptionStateJson ?? null),
      sellerRef: input.sellerRef !== undefined ? input.sellerRef : current.sellerRef,
      providerReferralId:
        input.providerReferralId !== undefined
          ? input.providerReferralId
          : current.providerReferralId,
      executionLeaseExpiresAt:
        input.executionLeaseExpiresAt !== undefined
          ? input.executionLeaseExpiresAt
          : current.executionLeaseExpiresAt,
      executionOwnerToken:
        input.executionOwnerToken !== undefined
          ? input.executionOwnerToken
          : current.executionOwnerToken,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    this.assertProviderIdsUnbound(updated);
    assertTransitionAllowed(current.status, input.nextStatus);

    this.operations.set(updated.operationId, updated);
    this.operationsByIdempotency.set(
      `${updated.idempotencyScope}::${updated.idempotencyKey}`,
      updated,
    );
    this.indexOperationReferences(updated);

    this.transitions.push({
      transitionId: randomUUID(),
      operationId: updated.operationId,
      fromStatus: current.status,
      toStatus: input.nextStatus,
      evidenceId: input.evidenceId ?? null,
      reason: input.reason,
      transitionKind: input.transitionKind ?? null,
      createdAt: updated.updatedAt,
    });

    return updated;
  }

  async listOperationTransitions(operationId: string): Promise<PaymentOperationTransitionRecord[]> {
    return this.transitions.filter((row) => row.operationId === operationId);
  }

  async insertEvidence(input: InsertProviderEvidenceInput): Promise<ProviderEvidenceRecord> {
    const scopeKey = `${input.providerCode}::${input.accountRef}::${input.environment}::${input.providerEventId}`;
    const existing = this.evidenceByProviderEvent.get(scopeKey);
    if (existing) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.EVIDENCE_DUPLICATE,
        'Provider event already exists in the inbox',
      );
    }

    const timestamp = nowIso();
    const record: ProviderEvidenceRecord = {
      evidenceId: randomUUID(),
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      evidenceKind: input.evidenceKind,
      providerEventId: input.providerEventId,
      relatedOperationId: null,
      receivedAt: timestamp,
      verificationStatus: 'pending',
      payloadSha256: input.payloadSha256,
      processingStatus: 'pending',
      eventType: input.eventType ?? null,
      resourceId: input.resourceId ?? null,
      errorCode: null,
      errorMessage: null,
      claimLeaseExpiresAt: null,
      claimWorkerId: null,
      processedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      rawPayload: input.rawPayload,
    };
    this.evidence.set(record.evidenceId, record);
    this.evidenceByProviderEvent.set(scopeKey, record);
    return record;
  }

  async findEvidenceById(evidenceId: string): Promise<ProviderEvidenceRecord | null> {
    return this.evidence.get(evidenceId) ?? null;
  }

  async findEvidenceByProviderEvent(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerEventId: string,
  ): Promise<ProviderEvidenceRecord | null> {
    return (
      this.evidenceByProviderEvent.get(
        `${providerCode}::${accountRef}::${environment}::${providerEventId}`,
      ) ?? null
    );
  }

  async updateEvidence(input: UpdateProviderEvidenceInput): Promise<ProviderEvidenceRecord> {
    const current = this.evidence.get(input.evidenceId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Evidence was not found',
      );
    }
    const updated: ProviderEvidenceRecord = {
      ...current,
      verificationStatus: input.verificationStatus ?? current.verificationStatus,
      processingStatus: input.processingStatus ?? current.processingStatus,
      relatedOperationId:
        input.relatedOperationId !== undefined
          ? input.relatedOperationId
          : current.relatedOperationId,
      eventType: input.eventType !== undefined ? input.eventType : current.eventType,
      resourceId: input.resourceId !== undefined ? input.resourceId : current.resourceId,
      errorCode: input.errorCode !== undefined ? input.errorCode : current.errorCode,
      errorMessage: input.errorMessage !== undefined ? input.errorMessage : current.errorMessage,
      claimLeaseExpiresAt:
        input.claimLeaseExpiresAt !== undefined
          ? input.claimLeaseExpiresAt
          : current.claimLeaseExpiresAt,
      claimWorkerId:
        input.claimWorkerId !== undefined ? input.claimWorkerId : current.claimWorkerId,
      processedAt: input.processedAt !== undefined ? input.processedAt : current.processedAt,
      consumerDeliveryStatus:
        input.consumerDeliveryStatus !== undefined
          ? input.consumerDeliveryStatus
          : current.consumerDeliveryStatus,
      consumerDeliveredAt:
        input.consumerDeliveredAt !== undefined
          ? input.consumerDeliveredAt
          : current.consumerDeliveredAt,
      consumerDeliveryAttempts:
        input.consumerDeliveryAttempts !== undefined
          ? input.consumerDeliveryAttempts
          : current.consumerDeliveryAttempts,
      consumerDeliveryLastError:
        input.consumerDeliveryLastError !== undefined
          ? input.consumerDeliveryLastError
          : current.consumerDeliveryLastError,
      attempts: input.attempts !== undefined ? input.attempts : current.attempts,
      nextAttemptAt:
        input.nextAttemptAt !== undefined ? input.nextAttemptAt : current.nextAttemptAt,
      retryStatus: input.retryStatus !== undefined ? input.retryStatus : current.retryStatus,
      updatedAt: nowIso(),
    };
    this.evidence.set(updated.evidenceId, updated);
    const scopeKey = `${updated.providerCode}::${updated.accountRef}::${updated.environment}::${updated.providerEventId}`;
    this.evidenceByProviderEvent.set(scopeKey, updated);
    return updated;
  }

  async claimPendingEvidence(input: ClaimPendingEvidenceInput): Promise<ProviderEvidenceRecord[]> {
    const now = Date.now();
    const workerId = input.workerId?.trim();
    if (!workerId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'claimPendingEvidence requires workerId',
      );
    }
    const leaseAvailable = (row: ProviderEvidenceRecord) =>
      !row.claimLeaseExpiresAt ||
      Date.parse(row.claimLeaseExpiresAt) <= now ||
      row.claimWorkerId === workerId;
    const scopeMatch = (row: ProviderEvidenceRecord) => {
      if (input.environment && row.environment !== input.environment) {
        return false;
      }
      if (input.providerCode && row.providerCode !== input.providerCode) {
        return false;
      }
      if (input.accountRef && row.accountRef !== input.accountRef) {
        return false;
      }
      if (input.evidenceIds?.length && !input.evidenceIds.includes(row.evidenceId)) {
        return false;
      }
      return true;
    };
    const deliveryWanted = (row: ProviderEvidenceRecord) =>
      input.includeConsumerDelivery !== false || !isAwaitingConsumerDeliveryOnly(row);
    const verificationWanted = (row: ProviderEvidenceRecord) =>
      input.includePendingVerification !== false || row.verificationStatus !== 'pending';
    // Rows named explicitly are claimed whatever their backoff; `gave_up` still excludes them.
    const due = (row: ProviderEvidenceRecord) =>
      Boolean(input.evidenceIds?.length) || isRetryDue({ nextAttemptAt: row.nextAttemptAt }, now);
    const candidates = [...this.evidence.values()]
      .filter(
        (row) =>
          leaseAvailable(row) &&
          scopeMatch(row) &&
          isRecoverableEvidenceRow(row) &&
          deliveryWanted(row) &&
          verificationWanted(row) &&
          due(row),
      )
      .sort(byNextAttemptAt)
      .slice(0, input.limit);
    const leaseUntil = new Date(now + input.leaseMs).toISOString();
    return Promise.all(
      candidates.map((row) =>
        this.updateEvidence({
          evidenceId: row.evidenceId,
          claimLeaseExpiresAt: leaseUntil,
          claimWorkerId: workerId,
        }),
      ),
    );
  }

  async reviveUnmatchedEvidence(input: ReviveUnmatchedEvidenceInput): Promise<number> {
    const rows = [...this.evidence.values()].filter(
      (row) =>
        row.evidenceKind === 'webhook' &&
        row.verificationStatus === 'verified' &&
        row.processingStatus === 'unmatched' &&
        row.providerCode === input.providerCode &&
        row.accountRef === input.accountRef &&
        row.environment === input.environment &&
        row.resourceId === input.resourceId &&
        hasRetryState(row),
    );
    for (const row of rows) {
      await this.updateEvidence({ evidenceId: row.evidenceId, ...CLEARED_RETRY_STATE });
    }
    return rows.length;
  }

  async listProviderEvidenceForRecovery(
    input: ListPaymentEvidenceForRecoveryInput,
  ): Promise<ListPaymentEvidenceForRecoveryResult> {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const providerCode = input.providerCode;
    const accountRef = input.accountRef;
    const rows = [...this.evidence.values()]
      .filter((row) => row.environment === input.environment)
      .filter((row) => (providerCode ? row.providerCode === providerCode : true))
      .filter((row) => (accountRef ? row.accountRef === accountRef : true))
      .filter((row) => (input.recoverableOnly ? isRecoverableEvidenceRow(row) : true))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const slice = rows.slice(offset, offset + limit);
    return {
      items: slice.map((row) => toPaymentEvidenceAdminView(row)),
      limit,
      offset,
    };
  }

  async listReconciliationCandidates(limit: number): Promise<ProviderEvidenceRecord[]> {
    const now = Date.now();
    return [...this.evidence.values()]
      .filter(
        (row) =>
          row.evidenceKind === 'webhook' &&
          row.verificationStatus === 'verified' &&
          (row.processingStatus === 'unmatched' ||
            (row.relatedOperationId &&
              this.operations.get(row.relatedOperationId)?.status === 'unknown')) &&
          isRetryDue(row, now),
      )
      .sort(byNextAttemptAt)
      .slice(0, limit);
  }

  async listUncertainOperations(
    limit: number,
    options: ListUncertainOperationsOptions = {},
  ): Promise<PaymentOperation[]> {
    const now = Date.now();
    const staleBefore = options.submittedStaleBefore
      ? Date.parse(options.submittedStaleBefore)
      : Number.NaN;
    const staleKinds = options.submittedStaleKinds ?? DEFAULT_SUBMITTED_STALE_KINDS;
    const isStaleSubmitted = (operation: PaymentOperation) =>
      operation.status === 'submitted' &&
      Number.isFinite(staleBefore) &&
      staleKinds.includes(operation.kind) &&
      !operation.providerReferenceId &&
      Date.parse(operation.updatedAt) <= staleBefore &&
      !(
        operation.executionOwnerToken &&
        operation.executionLeaseExpiresAt &&
        Date.parse(operation.executionLeaseExpiresAt) > now
      );
    return [...this.operations.values()]
      .filter(
        (operation) =>
          (operation.status === 'unknown' || isStaleSubmitted(operation)) &&
          isRetryDue(operation, now),
      )
      .sort(operationsByNextAttemptAt)
      .slice(0, limit);
  }

  async listOperationsByParent(parentOperationId: string): Promise<PaymentOperation[]> {
    return [...this.operations.values()].filter(
      (operation) => operation.parentOperationId === parentOperationId,
    );
  }

  async reserveRefundCapacity(input: {
    captureOperationId: string;
    requestedAmountMinor: string;
    excludeOperationId?: string;
  }): Promise<void> {
    const capture = await this.findOperationById(input.captureOperationId);
    if (!capture || capture.kind !== 'capture' || capture.status !== 'succeeded') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Successful capture operation was not found',
      );
    }
    if (!capture.amountMinor) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Capture amount is unavailable for refund reservation',
      );
    }

    const reservedStatuses = new Set(['prepared', 'submitted', 'unknown', 'succeeded']);
    const siblings = [...this.operations.values()].filter(
      (operation) =>
        operation.parentOperationId === input.captureOperationId &&
        operation.kind === 'refund' &&
        reservedStatuses.has(operation.status) &&
        operation.operationId !== input.excludeOperationId,
    );
    const reservedMinor = siblings.reduce(
      (total, operation) => total + BigInt(operation.amountMinor ?? '0'),
      0n,
    );
    const captureMinor = BigInt(capture.amountMinor);
    const requestedMinor = BigInt(input.requestedAmountMinor);
    if (requestedMinor > captureMinor - reservedMinor) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Refund amount exceeds remaining capture balance',
      );
    }
  }

  async insertReconciliationAttempt(
    input: InsertReconciliationAttemptInput,
  ): Promise<ReconciliationAttempt> {
    const attempt: ReconciliationAttempt = {
      attemptId: randomUUID(),
      evidenceId: input.evidenceId,
      operationId: input.operationId ?? null,
      outcome: input.outcome,
      resultCode: input.resultCode ?? null,
      resultMessage: input.resultMessage ?? null,
      createdAt: nowIso(),
    };
    this.reconciliationAttempts.push(attempt);
    return attempt;
  }

  /** Unique provider-id indexes: what a SQL store enforces with partial unique indexes. */
  private uniqueProviderIdEntries(
    operation: PaymentOperation,
  ): Array<[Map<string, PaymentOperation>, string]> {
    const scope = `${operation.providerCode}::${operation.accountRef}::${operation.environment}`;
    const entries: Array<[Map<string, PaymentOperation>, string]> = [];
    if (operation.providerReferenceId) {
      entries.push([this.operationsByProviderRef, `${scope}::${operation.providerReferenceId}`]);
    }
    if (operation.providerProductId && operation.kind === 'catalog_product') {
      entries.push([
        this.operationsByProviderProductId,
        `${scope}::${operation.providerProductId}`,
      ]);
    }
    if (operation.providerPlanId && operation.kind === 'billing_plan') {
      entries.push([this.operationsByProviderPlanId, `${scope}::${operation.providerPlanId}`]);
    }
    if (operation.providerSubscriptionId && operation.kind === 'subscription') {
      entries.push([
        this.operationsByProviderSubscriptionId,
        `${scope}::${operation.providerSubscriptionId}`,
      ]);
    }
    if (operation.providerReferralId && operation.kind === 'seller_referral') {
      entries.push([
        this.operationsByProviderReferralId,
        `${scope}::${operation.providerReferralId}`,
      ]);
    }
    return entries;
  }

  /** Rejects a write that would bind a unique provider id held by another operation. */
  private assertProviderIdsUnbound(operation: PaymentOperation): void {
    for (const [index, key] of this.uniqueProviderIdEntries(operation)) {
      const bound = index.get(key);
      if (bound && bound.operationId !== operation.operationId) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_RPC_TRANSITION_DETAIL.PROVIDER_REFERENCE_BOUND,
          {
            rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.PROVIDER_REFERENCE_BOUND,
          },
        );
      }
    }
  }

  private indexOperationReferences(operation: PaymentOperation): void {
    for (const [index, key] of this.operationIndexEntries.get(operation.operationId) ?? []) {
      if (index.get(key)?.operationId === operation.operationId) {
        index.delete(key);
      }
    }
    const scope = `${operation.providerCode}::${operation.accountRef}::${operation.environment}`;
    // Checkout and payout ids are not unique (a capture shares its order id): latest write wins.
    const entries = this.uniqueProviderIdEntries(operation);
    const shared: Array<[Map<string, PaymentOperation>, string | null]> = [
      [this.operationsByProviderOrderId, operation.providerOrderId],
      [this.operationsByProviderCaptureId, operation.providerCaptureId],
      [this.operationsByProviderRefundId, operation.providerRefundId],
      [this.operationsBySenderBatchId, operation.senderBatchId],
      [this.operationsBySenderItemId, operation.senderItemId],
      [this.operationsByProviderPayoutBatchId, operation.providerPayoutBatchId],
      [this.operationsByProviderPayoutItemId, operation.providerPayoutItemId],
    ];
    for (const [index, id] of shared) {
      if (id) {
        entries.push([index, `${scope}::${id}`]);
      }
    }
    for (const [index, key] of entries) {
      index.set(key, operation);
    }
    this.operationIndexEntries.set(operation.operationId, entries);
  }

  async createSellerConnection(
    input: CreateSellerConnectionInput,
  ): Promise<SellerConnectionRecord> {
    const existing = await this.findSellerConnectionBySellerRef(
      input.applicationRef,
      input.providerCode,
      input.accountRef,
      input.environment,
      input.sellerRef,
    );
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const record: SellerConnectionRecord = {
      connectionId: randomUUID(),
      applicationRef: input.applicationRef,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      environment: input.environment,
      sellerRef: input.sellerRef,
      trackingId: input.trackingId,
      latestReferralOperationId: input.latestReferralOperationId ?? null,
      providerReferralId: input.providerReferralId ?? null,
      providerMerchantId: null,
      connectionStatus: 'referral_created',
      consentStatus: 'unknown',
      paymentsReceivable: null,
      primaryEmailConfirmed: null,
      requiredPermissionsGranted: null,
      onboardingCompleted: false,
      restricted: false,
      readinessReady: false,
      readinessReasons: ['merchant identity is missing'],
      normalizedCapabilities: {},
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sellerConnections.set(record.connectionId, record);
    return record;
  }

  async findSellerConnectionById(connectionId: string): Promise<SellerConnectionRecord | null> {
    return this.sellerConnections.get(connectionId) ?? null;
  }

  async findSellerConnectionBySellerRef(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    sellerRef: string,
  ): Promise<SellerConnectionRecord | null> {
    return (
      [...this.sellerConnections.values()].find(
        (row) =>
          row.applicationRef === applicationRef &&
          row.providerCode === providerCode &&
          row.accountRef === accountRef &&
          row.environment === environment &&
          row.sellerRef === sellerRef,
      ) ?? null
    );
  }

  async findSellerConnectionByMerchantId(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    providerMerchantId: string,
  ): Promise<SellerConnectionRecord | null> {
    return (
      [...this.sellerConnections.values()].find(
        (row) =>
          row.applicationRef === applicationRef &&
          row.providerCode === providerCode &&
          row.accountRef === accountRef &&
          row.environment === environment &&
          row.providerMerchantId === providerMerchantId,
      ) ?? null
    );
  }

  async findSellerConnectionByReferralId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferralId: string,
  ): Promise<SellerConnectionRecord | null> {
    return (
      [...this.sellerConnections.values()].find(
        (row) =>
          row.providerCode === providerCode &&
          row.accountRef === accountRef &&
          row.environment === environment &&
          row.providerReferralId === providerReferralId,
      ) ?? null
    );
  }

  async findSellerConnectionByTrackingId(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    trackingId: string,
  ): Promise<SellerConnectionRecord | null> {
    return (
      [...this.sellerConnections.values()].find(
        (row) =>
          row.applicationRef === applicationRef &&
          row.providerCode === providerCode &&
          row.accountRef === accountRef &&
          row.environment === environment &&
          row.trackingId === trackingId,
      ) ?? null
    );
  }

  async listSellerConnectionsForReconciliation(limit: number): Promise<SellerConnectionRecord[]> {
    const eligible = new Set([
      'referral_created',
      'onboarding_pending',
      'restricted',
      'active',
      'revoked',
    ]);
    return [...this.sellerConnections.values()]
      .filter((row) => eligible.has(row.connectionStatus))
      .sort((left, right) => {
        const byUpdated = left.updatedAt.localeCompare(right.updatedAt);
        if (byUpdated !== 0) {
          return byUpdated;
        }
        return left.connectionId.localeCompare(right.connectionId);
      })
      .slice(0, limit);
  }

  async updateSellerConnection(
    input: UpdateSellerConnectionInput,
  ): Promise<SellerConnectionRecord> {
    const current = this.sellerConnections.get(input.connectionId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Seller connection was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Seller connection version conflict',
      );
    }
    if (input.providerMerchantId) {
      const bound = await this.findSellerConnectionByMerchantId(
        current.applicationRef,
        current.providerCode,
        current.accountRef,
        current.environment,
        input.providerMerchantId,
      );
      if (bound && bound.connectionId !== current.connectionId) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          'Provider merchant id is already bound to a different seller reference',
        );
      }
    }
    const updated: SellerConnectionRecord = {
      ...current,
      latestReferralOperationId:
        input.latestReferralOperationId !== undefined
          ? input.latestReferralOperationId
          : current.latestReferralOperationId,
      providerReferralId:
        input.providerReferralId !== undefined
          ? input.providerReferralId
          : current.providerReferralId,
      providerMerchantId:
        input.providerMerchantId !== undefined
          ? input.providerMerchantId
          : current.providerMerchantId,
      connectionStatus: input.connectionStatus ?? current.connectionStatus,
      consentStatus: input.consentStatus ?? current.consentStatus,
      paymentsReceivable:
        input.paymentsReceivable !== undefined
          ? input.paymentsReceivable
          : current.paymentsReceivable,
      primaryEmailConfirmed:
        input.primaryEmailConfirmed !== undefined
          ? input.primaryEmailConfirmed
          : current.primaryEmailConfirmed,
      requiredPermissionsGranted:
        input.requiredPermissionsGranted !== undefined
          ? input.requiredPermissionsGranted
          : current.requiredPermissionsGranted,
      onboardingCompleted: input.onboardingCompleted ?? current.onboardingCompleted,
      restricted: input.restricted ?? current.restricted,
      readinessReady: input.readinessReady ?? current.readinessReady,
      readinessReasons: input.readinessReasons ?? current.readinessReasons,
      normalizedCapabilities: input.normalizedCapabilities ?? current.normalizedCapabilities,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    this.sellerConnections.set(updated.connectionId, updated);
    return updated;
  }

  async insertMarketplacePurchaseUnits(
    units: InsertMarketplacePurchaseUnitInput[],
  ): Promise<MarketplacePurchaseUnitRecord[]> {
    const created = units.map((input) => {
      const record: MarketplacePurchaseUnitRecord = {
        unitId: randomUUID(),
        operationId: input.operationId,
        referenceId: input.referenceId,
        sellerRef: input.sellerRef,
        providerMerchantId: input.providerMerchantId ?? null,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        platformFeeMinor: input.platformFeeMinor ?? null,
        platformFeeCurrency: input.platformFeeCurrency ?? null,
        unitStatus: input.unitStatus ?? 'pending',
        providerCaptureId: null,
        providerFeeMinor: null,
        providerFeeCurrency: null,
        netAmountMinor: null,
        refundedMinor: '0',
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.marketplaceUnits.set(record.unitId, record);
      return record;
    });
    return created;
  }

  async listMarketplacePurchaseUnits(
    operationId: string,
  ): Promise<MarketplacePurchaseUnitRecord[]> {
    return [...this.marketplaceUnits.values()]
      .filter((unit) => unit.operationId === operationId)
      .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  }

  async findMarketplacePurchaseUnitById(
    unitId: string,
  ): Promise<MarketplacePurchaseUnitRecord | null> {
    return this.marketplaceUnits.get(unitId) ?? null;
  }

  async findMarketplacePurchaseUnitByReference(
    operationId: string,
    referenceId: string,
  ): Promise<MarketplacePurchaseUnitRecord | null> {
    return (
      [...this.marketplaceUnits.values()].find(
        (unit) => unit.operationId === operationId && unit.referenceId === referenceId,
      ) ?? null
    );
  }

  async findMarketplacePurchaseUnitByCaptureId(
    providerCaptureId: string,
  ): Promise<MarketplacePurchaseUnitRecord | null> {
    return this.marketplaceUnitsByCaptureId.get(providerCaptureId) ?? null;
  }

  async updateMarketplacePurchaseUnit(
    input: UpdateMarketplacePurchaseUnitInput,
  ): Promise<MarketplacePurchaseUnitRecord> {
    const current = this.marketplaceUnits.get(input.unitId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Marketplace purchase unit was not found',
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Marketplace purchase unit version conflict',
      );
    }
    const updated: MarketplacePurchaseUnitRecord = {
      ...current,
      unitStatus: input.unitStatus ?? current.unitStatus,
      providerCaptureId:
        input.providerCaptureId !== undefined ? input.providerCaptureId : current.providerCaptureId,
      providerFeeMinor:
        input.providerFeeMinor !== undefined ? input.providerFeeMinor : current.providerFeeMinor,
      providerFeeCurrency:
        input.providerFeeCurrency !== undefined
          ? input.providerFeeCurrency
          : current.providerFeeCurrency,
      netAmountMinor:
        input.netAmountMinor !== undefined ? input.netAmountMinor : current.netAmountMinor,
      refundedMinor: input.refundedMinor ?? current.refundedMinor,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    this.marketplaceUnits.set(updated.unitId, updated);
    if (updated.providerCaptureId) {
      this.marketplaceUnitsByCaptureId.set(updated.providerCaptureId, updated);
    }
    return updated;
  }

  async findLatestReconciliationEvidenceForResource(input: {
    applicationRef: string;
    providerCode: string;
    accountRef: string;
    environment: string;
    resourceId: string;
  }): Promise<ProviderEvidenceRecord | null> {
    const matches = [...this.evidence.values()]
      .filter(
        (row) =>
          row.evidenceKind === 'reconciliation' &&
          row.verificationStatus === 'verified' &&
          row.applicationRef === input.applicationRef &&
          row.providerCode === input.providerCode &&
          row.accountRef === input.accountRef &&
          row.environment === input.environment &&
          row.resourceId === input.resourceId,
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return matches[0] ?? null;
  }
}

export function toPaymentEvidenceAdminView(row: ProviderEvidenceRecord): PaymentEvidenceAdminView {
  return {
    evidenceId: row.evidenceId,
    providerCode: row.providerCode,
    accountRef: row.accountRef,
    applicationRef: row.applicationRef,
    environment: row.environment,
    providerEventId: row.providerEventId,
    relatedOperationId: row.relatedOperationId,
    receivedAt: row.receivedAt,
    verificationStatus: row.verificationStatus,
    processingStatus: row.processingStatus,
    consumerDeliveryStatus: row.consumerDeliveryStatus,
    consumerDeliveredAt: row.consumerDeliveredAt,
    consumerDeliveryAttempts: row.consumerDeliveryAttempts,
    consumerDeliveryLastError: row.consumerDeliveryLastError,
    attempts: row.attempts ?? null,
    nextAttemptAt: row.nextAttemptAt ?? null,
    retryStatus: row.retryStatus ?? null,
    eventType: row.eventType,
    resourceId: row.resourceId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    processedAt: row.processedAt,
    updatedAt: row.updatedAt,
  };
}

/** Kept for compatibility: the helper now lives in `../sha256-payload`. */
export { sha256Payload };
