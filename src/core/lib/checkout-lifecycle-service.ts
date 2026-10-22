import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
  classifyPaymentFailure,
  toPublicFailure,
  type CaptureCheckoutOrderRequest,
  type CheckoutCaptureResult,
  type CheckoutOrderResult,
  type CheckoutOrderStatus,
  type CreateCheckoutOrderRequest,
  type ExecuteGetCheckoutOrderResult,
  type CheckoutProviderCreateRetryEligibility,
  type GetCheckoutOrderRequest,
  type PaymentOperation,
  type RefundCaptureRequest,
  type RefundCaptureResult,
  type RetryCheckoutOrderRequest,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import {
  canonicalMoneyToLegacyMajorAmount,
  validateCanonicalMoney,
  validateOptionalRefundAmount,
} from './money';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import type { CheckoutProviderPort } from './checkout-provider-port';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import { resolveFirstProviderExecutionAt } from './provider-execution-transition';
import {
  isTerminalPreProviderFailureCode,
  resolveProviderFailure,
} from './resolve-provider-failure';

function isTerminal(status: PaymentOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

function toCheckoutOrderResult(
  operation: PaymentOperation,
  providerOrderIdOverride?: string | null,
): CheckoutOrderResult {
  const providerOrderId = operation.providerOrderId ?? providerOrderIdOverride ?? null;
  const approvalUrl = operation.approvalUrl;
  const checkoutStatus: CheckoutOrderStatus =
    operation.status === 'failed'
      ? 'failed'
      : operation.status === 'unknown'
        ? 'unknown'
        : 'created';
  const base = {
    operationId: operation.operationId,
    operationKind: 'checkout' as const,
    operationStatus: operation.status,
    providerOrderId,
    checkoutStatus,
    amount: {
      currency: operation.currencyCode ?? 'USD',
      amountMinor: operation.amountMinor ?? '0',
    },
    approvalUrl,
    correlationId: operation.correlationId,
  };

  if (
    providerOrderId &&
    approvalUrl &&
    operation.status !== 'failed' &&
    operation.status !== 'unknown'
  ) {
    return {
      ...base,
      outcome: 'requires_action',
      nextAction: 'approve',
      providerOrderId,
      approvalUrl,
    };
  }

  if (operation.status === 'unknown') {
    const failure =
      operation.failureCode != null
        ? toPublicFailure(
            classifyPaymentFailure({
              code: operation.failureCode,
              message: operation.failureMessage,
              providerAttempted: false,
            }),
          )
        : null;
    const nextAction =
      failure?.nextAction === 'contact_support'
        ? 'contact_support'
        : !providerOrderId
          ? 'resume_operation'
          : 'check_status';
    return {
      ...base,
      outcome: 'unknown',
      nextAction,
      uncertaintyReason: operation.failureMessage ?? 'Payment provider outcome is not confirmed',
      ...(failure && nextAction === 'contact_support' ? { failure } : {}),
    };
  }

  if (operation.status === 'failed') {
    const failure = toPublicFailure(
      classifyPaymentFailure({
        code: operation.failureCode,
        message: operation.failureMessage,
        providerAttempted: providerOrderId != null,
      }),
    );
    return {
      ...base,
      outcome: 'failed',
      nextAction: failure.nextAction,
      failure,
    };
  }

  if (operation.status === 'succeeded' && providerOrderId) {
    return { ...base, outcome: 'succeeded', nextAction: 'none', providerOrderId };
  }

  if (operation.status === 'submitted' && providerOrderId) {
    return { ...base, outcome: 'succeeded', nextAction: 'none', providerOrderId };
  }

  if (operation.status === 'submitted' || operation.status === 'prepared') {
    return { ...base, outcome: 'pending', nextAction: 'check_status' };
  }

  return {
    ...base,
    outcome: 'unknown',
    nextAction: 'check_status',
    uncertaintyReason: 'Checkout outcome is not confirmed',
  };
}

function unresolvedCreateRetryUncertaintyReason(
  eligibility: CheckoutProviderCreateRetryEligibility,
): string {
  return eligibility === 'expired'
    ? 'PayPal checkout create idempotency window has expired'
    : 'Original checkout provider execution time is not available';
}

function toCaptureResult(
  operation: PaymentOperation,
  checkoutOperationId: string,
  captureStatusOverride?: CheckoutOrderStatus,
  options?: { requiresApproval?: boolean; uncertaintyReason?: string },
): CheckoutCaptureResult {
  const captureStatus: CheckoutOrderStatus =
    captureStatusOverride ??
    (operation.status === 'succeeded'
      ? 'captured'
      : operation.status === 'failed'
        ? 'failed'
        : operation.status === 'unknown'
          ? 'unknown'
          : 'approved');
  const amount =
    operation.amountMinor && operation.currencyCode
      ? { amountMinor: operation.amountMinor, currency: operation.currencyCode }
      : null;
  const base = {
    operationId: operation.operationId,
    operationKind: 'capture' as const,
    operationStatus: operation.status,
    checkoutOperationId,
    providerOrderId: operation.providerOrderId ?? '',
    providerCaptureId: operation.providerCaptureId,
    captureStatus,
    amount,
    correlationId: operation.correlationId,
  };

  if (options?.requiresApproval) {
    return { ...base, outcome: 'requires_action', nextAction: 'approve' };
  }

  if (
    captureStatus === 'captured' &&
    operation.providerCaptureId &&
    amount &&
    operation.status === 'succeeded'
  ) {
    return {
      ...base,
      outcome: 'succeeded',
      nextAction: 'none',
      providerCaptureId: operation.providerCaptureId,
      amount,
    };
  }

  if (operation.status === 'failed' || captureStatus === 'failed') {
    const failure = toPublicFailure(
      classifyPaymentFailure({
        code: operation.failureCode,
        message: operation.failureMessage,
        providerAttempted: true,
      }),
    );
    return { ...base, outcome: 'failed', nextAction: failure.nextAction, failure };
  }

  if (operation.status === 'unknown' || captureStatus === 'unknown') {
    return {
      ...base,
      outcome: 'unknown',
      nextAction: 'check_status',
      uncertaintyReason:
        options?.uncertaintyReason ??
        operation.failureMessage ??
        'Capture outcome is not confirmed',
    };
  }

  if (captureStatus === 'approved' || captureStatus === 'created') {
    return { ...base, outcome: 'pending', nextAction: 'check_status' };
  }

  return {
    ...base,
    outcome: 'unknown',
    nextAction: 'check_status',
    uncertaintyReason: 'Capture outcome is not confirmed',
  };
}

function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertCheckoutOperationScope(
  operation: PaymentOperation,
  input: GetCheckoutOrderRequest,
): void {
  if (
    operation.providerCode !== input.providerCode ||
    operation.accountRef !== input.accountRef ||
    operation.applicationRef !== input.applicationRef ||
    operation.environment !== input.environment
  ) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Checkout operation scope does not match the lookup request',
    );
  }
}

function annotateCheckoutLookup(input: {
  operationId: string;
  operationStatus: PaymentOperation['status'];
  providerOrderId: string | null;
  checkoutStatus: CheckoutOrderStatus;
  amount: CheckoutOrderResult['amount'];
  approvalUrl: string | null;
  correlationId: string | null;
  providerDebugId?: string | null;
}): CheckoutOrderResult {
  const base = { ...input, operationKind: 'checkout' as const };
  if (
    input.providerOrderId &&
    input.approvalUrl &&
    input.checkoutStatus !== 'captured' &&
    input.checkoutStatus !== 'failed' &&
    input.checkoutStatus !== 'unknown'
  ) {
    return {
      ...base,
      outcome: 'requires_action',
      nextAction: 'approve',
      providerOrderId: input.providerOrderId,
      approvalUrl: input.approvalUrl,
    };
  }
  if (input.checkoutStatus === 'failed') {
    const failure = toPublicFailure(
      classifyPaymentFailure({ code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION }),
    );
    return { ...base, outcome: 'failed', nextAction: failure.nextAction, failure };
  }
  if (input.checkoutStatus === 'unknown' || !input.providerOrderId) {
    return {
      ...base,
      outcome: 'unknown',
      nextAction: 'check_status',
      uncertaintyReason: 'Checkout lookup did not confirm the order',
    };
  }
  if (
    input.checkoutStatus === 'captured' ||
    input.checkoutStatus === 'approved' ||
    input.checkoutStatus === 'created'
  ) {
    if (input.checkoutStatus === 'created' && input.approvalUrl) {
      return {
        ...base,
        outcome: 'requires_action',
        nextAction: 'approve',
        providerOrderId: input.providerOrderId,
        approvalUrl: input.approvalUrl,
      };
    }
    return {
      ...base,
      outcome: 'succeeded',
      nextAction: 'none',
      providerOrderId: input.providerOrderId,
    };
  }
  return {
    ...base,
    outcome: 'unknown',
    nextAction: 'check_status',
    uncertaintyReason: 'Checkout lookup did not confirm the order',
  };
}

function isPreApprovalCaptureRejection(operation: PaymentOperation): boolean {
  return (
    operation.status === 'failed' &&
    operation.failureCode === PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED
  );
}

function approvedOnceContinuationKey(idempotencyKey: string): string {
  return `${idempotencyKey}:approved-once`;
}

function hasCompletedProviderCapture(providerOrder: ExecuteGetCheckoutOrderResult): boolean {
  return (
    providerOrder.providerCaptureStatus === 'captured' &&
    providerOrder.providerCaptureId != null &&
    providerOrder.captureAmount != null
  );
}

function toRefundResult(
  operation: PaymentOperation,
  captureOperationId: string,
  providerCaptureId: string,
): RefundCaptureResult {
  return {
    operationId: operation.operationId,
    operationStatus: operation.status,
    captureOperationId,
    providerCaptureId,
    providerRefundId: operation.providerRefundId,
    refundStatus:
      operation.status === 'succeeded'
        ? 'completed'
        : operation.status === 'failed'
          ? 'failed'
          : operation.status === 'unknown'
            ? 'unknown'
            : 'pending',
    amount:
      operation.amountMinor && operation.currencyCode
        ? { amountMinor: operation.amountMinor, currency: operation.currencyCode }
        : null,
    correlationId: operation.correlationId,
  };
}

export type CheckoutCreateRetryOptions = {
  evaluateProviderCreateRetryEligibility: (
    firstProviderExecutionAt: string | null,
  ) => CheckoutProviderCreateRetryEligibility;
};

export class CheckoutLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: CheckoutProviderPort,
  ) {}

  async createCheckoutOrder(
    input: CreateCheckoutOrderRequest,
    options?: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    const amount = validateCanonicalMoney(input.amount);
    const fingerprint = buildCommandFingerprint({
      amount,
      referenceId: input.referenceId ?? null,
      returnUrl: input.returnUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'checkout',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'checkout',
      correlationId: input.correlationId ?? null,
      amountMinor: amount.amountMinor,
      currencyCode: amount.currency,
    });

    if (isTerminal(operation.status)) {
      return this.presentCheckoutOrderResult(operation, null, options);
    }
    if (operation.status === 'submitted' || operation.status === 'unknown') {
      return this.presentCheckoutOrderResult(operation, null, options);
    }

    const lease = await this.store.acquireCheckoutCreateExecutionLease({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });
    if (lease.kind === 'in_flight') {
      return this.presentCheckoutOrderResult(lease.operation, null, options);
    }
    if (lease.kind === 'not_eligible') {
      return this.presentCheckoutOrderResult(lease.operation, null, options);
    }
    operation = lease.operation;
    const executionOwnerToken = lease.executionOwnerToken;

    let providerResult: Awaited<ReturnType<CheckoutProviderPort['createOrder']>> | null = null;
    try {
      providerResult = await this.provider.createOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        amount,
        referenceId: input.referenceId ?? null,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
      });

      operation = await this.persistCheckoutCreateExecutionTransition(
        operation,
        executionOwnerToken,
        {
          nextStatus: 'submitted',
          providerReferenceId: providerResult.providerOrderId,
          providerOrderId: providerResult.providerOrderId,
          approvalUrl: providerResult.approvalUrl,
          amountMinor: providerResult.amount.amountMinor,
          currencyCode: providerResult.amount.currency,
          reason: 'Checkout order created at provider',
        },
      );
    } catch (error) {
      if (providerResult?.providerOrderId) {
        operation = await this.persistCheckoutCreateExecutionTransition(
          operation,
          executionOwnerToken,
          {
            nextStatus: 'unknown',
            providerReferenceId: providerResult.providerOrderId,
            providerOrderId: providerResult.providerOrderId,
            approvalUrl: providerResult.approvalUrl,
            amountMinor: providerResult.amount.amountMinor,
            currencyCode: providerResult.amount.currency,
            reason: 'Provider checkout created; local persistence uncertain',
          },
        );
      } else {
        operation = await this.handleProviderFailure(operation, error, executionOwnerToken);
      }
    }

    return this.presentCheckoutOrderResult(operation, null, options);
  }

  async retryCheckoutOrder(
    input: RetryCheckoutOrderRequest,
    options: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    let operation = await this.store.findOperationById(input.checkoutOperationId);
    if (!operation || operation.kind !== 'checkout') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Checkout operation was not found',
      );
    }
    assertCheckoutOperationScope(operation, input);

    const amount = validateCanonicalMoney(input.amount);
    const fingerprint = buildCommandFingerprint({
      amount,
      referenceId: input.referenceId ?? null,
      returnUrl: input.returnUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
    });
    if (fingerprint !== operation.commandFingerprint) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
        'Retry parameters do not match the original checkout command',
      );
    }

    if (operation.providerOrderId || operation.providerReferenceId) {
      return this.presentCheckoutOrderResult(operation, null, options);
    }
    if (isTerminal(operation.status)) {
      return this.presentCheckoutOrderResult(operation, null, options);
    }
    if (operation.status !== 'unknown' && operation.status !== 'submitted') {
      if (operation.status === 'prepared') {
        return this.presentCheckoutOrderResult(operation, null, options);
      }
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Checkout operation is not eligible for create retry',
      );
    }

    if (!this.isCheckoutExecutionLeaseInFlight(operation)) {
      const firstExecutionAt = await this.resolveFirstCheckoutProviderExecutionAt(
        operation.operationId,
      );
      const eligibility = options.evaluateProviderCreateRetryEligibility(firstExecutionAt);
      if (eligibility !== 'allowed') {
        return this.toCheckoutCreateRetryBlockedResult(
          operation,
          unresolvedCreateRetryUncertaintyReason(eligibility),
          options,
        );
      }
    }

    const latest = await this.store.findOperationById(operation.operationId);
    if (!latest || latest.kind !== 'checkout') {
      return this.presentCheckoutOrderResult(latest ?? operation, null, options);
    }
    operation = latest;

    const lease = await this.store.acquireCheckoutCreateExecutionLease({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });
    if (lease.kind === 'in_flight') {
      return this.presentCheckoutOrderResult(lease.operation, null, options);
    }
    if (lease.kind === 'not_eligible') {
      return this.presentCheckoutOrderResult(lease.operation, null, options);
    }

    return this.executeCheckoutCreateProviderRetry(
      input,
      lease.operation,
      lease.executionOwnerToken,
      amount,
      options,
    );
  }

  async getCheckoutOrder(
    input: GetCheckoutOrderRequest,
    options?: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    const providerOrderIdInput = nullIfBlank(input.providerOrderId);
    const checkoutOperationIdInput = nullIfBlank(input.checkoutOperationId);

    if (!providerOrderIdInput && !checkoutOperationIdInput) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Checkout lookup requires a provider order id or checkout operation id',
      );
    }

    let operation: PaymentOperation | null = null;

    if (checkoutOperationIdInput) {
      const byId = await this.store.findOperationById(checkoutOperationIdInput);
      if (!byId) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Checkout operation was not found',
        );
      }
      if (byId.kind !== 'checkout') {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Payment operation is not a checkout',
        );
      }
      assertCheckoutOperationScope(byId, input);
      if (
        providerOrderIdInput &&
        byId.providerOrderId &&
        byId.providerOrderId !== providerOrderIdInput
      ) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Checkout operation does not match the provider order id',
        );
      }
      operation = byId;
    }

    if (!operation && providerOrderIdInput) {
      operation = await this.store.findOperationByProviderOrderId(
        input.providerCode,
        input.accountRef,
        input.environment,
        providerOrderIdInput,
      );
    }

    const resolvedProviderOrderId = operation?.providerOrderId ?? providerOrderIdInput ?? null;

    if (!resolvedProviderOrderId) {
      return this.presentCheckoutOrderResult(operation as PaymentOperation, null, options);
    }

    const providerResult = await this.provider.getOrder({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerOrderId: resolvedProviderOrderId,
    });

    if (operation) {
      const approvalUrl = providerResult.approvalUrl ?? operation.approvalUrl;
      if (providerResult.approvalUrl && !operation.approvalUrl) {
        await this.store.transitionOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          nextStatus: operation.status,
          approvalUrl: providerResult.approvalUrl,
          reason: 'Backfilled approval URL from provider lookup',
        });
      }
      return annotateCheckoutLookup({
        operationId: operation.operationId,
        operationStatus: operation.status,
        providerOrderId: providerResult.providerOrderId,
        checkoutStatus: providerResult.checkoutStatus,
        amount: providerResult.amount ?? {
          currency: operation.currencyCode ?? 'USD',
          amountMinor: operation.amountMinor ?? '0',
        },
        approvalUrl,
        correlationId: operation.correlationId,
        providerDebugId: providerResult.providerDebugId ?? null,
      });
    }

    return annotateCheckoutLookup({
      operationId: providerOrderIdInput ?? checkoutOperationIdInput ?? resolvedProviderOrderId,
      operationStatus: 'prepared',
      providerOrderId: providerResult.providerOrderId,
      checkoutStatus: providerResult.checkoutStatus,
      amount: providerResult.amount ?? { currency: 'USD', amountMinor: '0' },
      approvalUrl: providerResult.approvalUrl,
      correlationId: null,
      providerDebugId: providerResult.providerDebugId ?? null,
    });
  }

  async captureCheckoutOrder(input: CaptureCheckoutOrderRequest): Promise<CheckoutCaptureResult> {
    let checkoutOp = await this.store.findOperationById(input.checkoutOperationId);
    if (!checkoutOp || checkoutOp.kind !== 'checkout') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Checkout operation was not found',
      );
    }

    const fingerprint = buildCommandFingerprint({
      checkoutOperationId: input.checkoutOperationId,
      providerOrderId: input.providerOrderId,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'capture',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'capture',
      correlationId: input.correlationId ?? null,
      parentOperationId: checkoutOp.operationId,
      providerOrderId: input.providerOrderId,
      amountMinor: checkoutOp.amountMinor,
      currencyCode: checkoutOp.currencyCode,
    });

    if (operation.status === 'succeeded' && operation.providerCaptureId) {
      return toCaptureResult(operation, checkoutOp.operationId);
    }

    let providerOrder: ExecuteGetCheckoutOrderResult;
    try {
      providerOrder = await this.provider.getOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerOrderId: input.providerOrderId,
      });
    } catch {
      return toCaptureResult(operation, checkoutOp.operationId, 'unknown');
    }

    if (providerOrder.approvalUrl && !checkoutOp.approvalUrl) {
      checkoutOp = await this.store.transitionOperation({
        operationId: checkoutOp.operationId,
        expectedVersion: checkoutOp.version,
        nextStatus: checkoutOp.status,
        approvalUrl: providerOrder.approvalUrl,
        reason: 'Backfilled approval URL before capture',
      });
    }

    if (hasCompletedProviderCapture(providerOrder)) {
      const captureAmount = providerOrder.captureAmount;
      if (!captureAmount) {
        return toCaptureResult(operation, checkoutOp.operationId, 'unknown');
      }
      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'succeeded',
        providerReferenceId: providerOrder.providerCaptureId ?? input.providerOrderId,
        providerCaptureId: providerOrder.providerCaptureId,
        amountMinor: captureAmount.amountMinor,
        currencyCode: captureAmount.currency,
        reason: 'Capture reconciled from provider order lookup',
      });
      return toCaptureResult(operation, checkoutOp.operationId, 'captured');
    }

    if (
      providerOrder.providerCaptureId &&
      (providerOrder.providerCaptureStatus !== 'captured' ||
        (providerOrder.providerCaptureStatus === 'captured' && !providerOrder.captureAmount))
    ) {
      return toCaptureResult(operation, checkoutOp.operationId, 'unknown');
    }

    if (
      providerOrder.checkoutStatus !== 'approved' &&
      providerOrder.checkoutStatus !== 'captured'
    ) {
      return toCaptureResult(operation, checkoutOp.operationId, 'created');
    }

    if (operation.status === 'failed' && !isPreApprovalCaptureRejection(operation)) {
      return toCaptureResult(operation, checkoutOp.operationId, 'failed');
    }

    let executingOperation: PaymentOperation;
    let claimedForExecution = false;
    if (isPreApprovalCaptureRejection(operation)) {
      const continuation = await this.resolveApprovedContinuationCapture(
        operation,
        input,
        checkoutOp,
        scope,
        fingerprint,
      );
      executingOperation = continuation.operation;
      claimedForExecution = continuation.claimedForExecution;
    } else if (operation.status === 'unknown') {
      const claimed = await this.claimUnknownCaptureRetry(operation);
      if (!claimed) {
        return toCaptureResult(operation, checkoutOp.operationId, 'unknown');
      }
      executingOperation = claimed;
      claimedForExecution = true;
    } else if (operation.status === 'prepared') {
      executingOperation = await this.store.claimOperationForExecution({
        operationId: operation.operationId,
        expectedVersion: operation.version,
      });
      claimedForExecution = true;
    } else if (operation.status === 'submitted') {
      return toCaptureResult(operation, checkoutOp.operationId, 'unknown');
    } else if (operation.status === 'succeeded') {
      return toCaptureResult(operation, checkoutOp.operationId, 'captured');
    } else {
      return toCaptureResult(operation, checkoutOp.operationId, 'failed');
    }

    if (executingOperation.status === 'succeeded' && executingOperation.providerCaptureId) {
      return toCaptureResult(executingOperation, checkoutOp.operationId, 'captured');
    }

    if (executingOperation.status === 'submitted' && !claimedForExecution) {
      return toCaptureResult(executingOperation, checkoutOp.operationId, 'unknown');
    }

    try {
      const providerResult = await this.provider.captureOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: executingOperation.operationId,
        providerOrderId: input.providerOrderId,
      });

      if (providerResult.captureStatus !== 'captured') {
        return toCaptureResult(
          executingOperation,
          checkoutOp.operationId,
          providerResult.captureStatus,
        );
      }

      executingOperation = await this.store.transitionOperation({
        operationId: executingOperation.operationId,
        expectedVersion: executingOperation.version,
        nextStatus: 'succeeded',
        providerReferenceId: providerResult.providerCaptureId ?? input.providerOrderId,
        providerCaptureId: providerResult.providerCaptureId,
        amountMinor: providerResult.amount?.amountMinor ?? executingOperation.amountMinor,
        currencyCode: providerResult.amount?.currency ?? executingOperation.currencyCode,
        reason: 'Capture executed at provider',
      });
      return toCaptureResult(executingOperation, checkoutOp.operationId, 'captured');
    } catch (error) {
      const err = error as { code?: string; uncertain?: boolean; retryable?: boolean };
      if (err?.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED) {
        executingOperation = await this.handleProviderFailure(executingOperation, error);
        return toCaptureResult(executingOperation, checkoutOp.operationId, 'created', {
          requiresApproval: true,
        });
      }
      if (err?.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_STATE_CONFLICT) {
        const reconciled = await this.provider.getOrder({
          providerCode: input.providerCode,
          accountRef: input.accountRef,
          applicationRef: input.applicationRef,
          environment: input.environment,
          providerOrderId: input.providerOrderId,
        });
        if (hasCompletedProviderCapture(reconciled)) {
          const captureAmount = reconciled.captureAmount;
          if (!captureAmount) {
            return toCaptureResult(executingOperation, checkoutOp.operationId, 'unknown');
          }
          executingOperation = await this.store.transitionOperation({
            operationId: executingOperation.operationId,
            expectedVersion: executingOperation.version,
            nextStatus: 'succeeded',
            providerReferenceId: reconciled.providerCaptureId ?? input.providerOrderId,
            providerCaptureId: reconciled.providerCaptureId,
            amountMinor: captureAmount.amountMinor,
            currencyCode: captureAmount.currency,
            reason: 'Capture reconciled after provider state conflict',
          });
          return toCaptureResult(executingOperation, checkoutOp.operationId, 'captured');
        }
        return toCaptureResult(executingOperation, checkoutOp.operationId, 'unknown');
      }
      executingOperation = await this.handleProviderFailure(executingOperation, error);
      return toCaptureResult(executingOperation, checkoutOp.operationId);
    }
  }

  async refundCapture(input: RefundCaptureRequest): Promise<RefundCaptureResult> {
    const captureOp = await this.store.findOperationById(input.captureOperationId);
    if (!captureOp || captureOp.kind !== 'capture' || captureOp.status !== 'succeeded') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Successful capture operation was not found',
      );
    }

    const refundAmount = validateOptionalRefundAmount(input.amount);
    const fingerprint = buildCommandFingerprint({
      captureOperationId: input.captureOperationId,
      providerCaptureId: input.providerCaptureId,
      amount: refundAmount,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'refund',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'refund',
      correlationId: input.correlationId ?? null,
      parentOperationId: captureOp.operationId,
      providerCaptureId: input.providerCaptureId,
      providerOrderId: captureOp.providerOrderId,
      amountMinor: refundAmount?.amountMinor ?? captureOp.amountMinor,
      currencyCode: refundAmount?.currency ?? captureOp.currencyCode,
    });

    if (isTerminal(operation.status)) {
      return toRefundResult(operation, captureOp.operationId, input.providerCaptureId);
    }
    if (operation.status === 'submitted' || operation.status === 'unknown') {
      return toRefundResult(operation, captureOp.operationId, input.providerCaptureId);
    }

    const reservedAmountMinor = refundAmount?.amountMinor ?? captureOp.amountMinor ?? '0';
    await this.store.reserveRefundCapacity({
      captureOperationId: captureOp.operationId,
      requestedAmountMinor: reservedAmountMinor,
      excludeOperationId: operation.operationId,
    });

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const providerResult = await this.provider.refundCapture({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        providerCaptureId: input.providerCaptureId,
        amount: refundAmount,
      });

      const nextStatus =
        providerResult.refundStatus === 'completed'
          ? 'succeeded'
          : providerResult.refundStatus === 'failed'
            ? 'failed'
            : 'unknown';

      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus,
        providerReferenceId: providerResult.providerRefundId,
        providerRefundId: providerResult.providerRefundId,
        amountMinor: providerResult.amount?.amountMinor ?? operation.amountMinor,
        currencyCode: providerResult.amount?.currency ?? operation.currencyCode,
        reason: 'Refund executed at provider',
      });
    } catch (error) {
      operation = await this.handleProviderFailure(operation, error);
    }

    return toRefundResult(operation, captureOp.operationId, input.providerCaptureId);
  }

  /** Exposed for legacy compatibility mapping in payment MS. */
  legacyMajorAmountFromMinor(amountMinor: string, currency: string): string {
    return canonicalMoneyToLegacyMajorAmount({ amountMinor, currency });
  }

  private isCheckoutExecutionLeaseInFlight(operation: PaymentOperation): boolean {
    if (!operation.executionOwnerToken || !operation.executionLeaseExpiresAt) {
      return false;
    }
    const expiresMs = Date.parse(operation.executionLeaseExpiresAt);
    return Number.isFinite(expiresMs) && Date.now() < expiresMs;
  }

  private async presentCheckoutOrderResult(
    operation: PaymentOperation,
    providerOrderIdOverride?: string | null,
    options?: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    const result = toCheckoutOrderResult(operation, providerOrderIdOverride);
    const providerOrderId = operation.providerOrderId ?? providerOrderIdOverride ?? null;
    if (providerOrderId) {
      return result;
    }
    if (operation.status === 'prepared') {
      return result;
    }
    if (operation.status !== 'unknown' && operation.status !== 'submitted') {
      return result;
    }

    if (this.isCheckoutExecutionLeaseInFlight(operation)) {
      return {
        ...result,
        outcome: 'pending',
        nextAction: 'check_status',
      };
    }

    if (!options?.evaluateProviderCreateRetryEligibility) {
      return result;
    }

    const firstExecutionAt = await this.resolveFirstCheckoutProviderExecutionAt(
      operation.operationId,
    );
    const eligibility = options.evaluateProviderCreateRetryEligibility(firstExecutionAt);
    if (eligibility === 'allowed') {
      if (result.outcome === 'unknown') {
        return { ...result, nextAction: 'resume_operation' };
      }
      if (result.outcome === 'pending') {
        return {
          ...result,
          outcome: 'unknown',
          nextAction: 'resume_operation',
          uncertaintyReason: 'Checkout create may be retried',
        };
      }
      return result;
    }

    if (result.outcome === 'unknown') {
      return {
        ...result,
        nextAction: 'contact_support',
        uncertaintyReason: unresolvedCreateRetryUncertaintyReason(eligibility),
      };
    }
    if (result.outcome === 'pending') {
      return {
        ...result,
        outcome: 'unknown',
        nextAction: 'contact_support',
        uncertaintyReason: unresolvedCreateRetryUncertaintyReason(eligibility),
      };
    }
    return result;
  }

  private async executeCheckoutCreateProviderRetry(
    input: RetryCheckoutOrderRequest,
    operation: PaymentOperation,
    executionOwnerToken: string,
    amount: ReturnType<typeof validateCanonicalMoney>,
    options: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    let executingOperation = operation;
    let providerResult: Awaited<ReturnType<CheckoutProviderPort['createOrder']>> | null = null;
    try {
      providerResult = await this.provider.createOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: executingOperation.operationId,
        amount,
        referenceId: input.referenceId ?? null,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
      });

      executingOperation = await this.persistCheckoutCreateExecutionTransition(
        executingOperation,
        executionOwnerToken,
        {
          nextStatus: 'submitted',
          providerReferenceId: providerResult.providerOrderId,
          providerOrderId: providerResult.providerOrderId,
          approvalUrl: providerResult.approvalUrl,
          amountMinor: providerResult.amount.amountMinor,
          currencyCode: providerResult.amount.currency,
          reason: 'Checkout order created at provider after retry',
        },
      );
    } catch (error) {
      if (providerResult?.providerOrderId) {
        executingOperation = await this.persistCheckoutCreateExecutionTransition(
          executingOperation,
          executionOwnerToken,
          {
            nextStatus: 'unknown',
            providerReferenceId: providerResult.providerOrderId,
            providerOrderId: providerResult.providerOrderId,
            approvalUrl: providerResult.approvalUrl,
            amountMinor: providerResult.amount.amountMinor,
            currencyCode: providerResult.amount.currency,
            reason: 'Provider checkout created; local persistence uncertain after retry',
          },
        );
      } else {
        executingOperation = await this.handleProviderFailure(
          executingOperation,
          error,
          executionOwnerToken,
        );
      }
    }

    return this.presentCheckoutOrderResult(executingOperation, null, options);
  }

  private async resolveFirstCheckoutProviderExecutionAt(
    operationId: string,
  ): Promise<string | null> {
    return resolveFirstProviderExecutionAt(await this.store.listOperationTransitions(operationId));
  }

  private async toCheckoutCreateRetryBlockedResult(
    operation: PaymentOperation,
    uncertaintyReason: string,
    options: CheckoutCreateRetryOptions,
  ): Promise<CheckoutOrderResult> {
    const base = await this.presentCheckoutOrderResult(operation, null, options);
    return {
      ...base,
      outcome: 'unknown',
      nextAction: 'contact_support',
      uncertaintyReason,
    };
  }

  private async claimUnknownCaptureRetry(
    operation: PaymentOperation,
  ): Promise<PaymentOperation | null> {
    try {
      return await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'unknown',
        reason: 'Claimed unknown capture retry',
      });
    } catch (error) {
      if (
        error instanceof PaymentReliabilityError &&
        (error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT ||
          error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED)
      ) {
        return null;
      }
      throw error;
    }
  }

  private async resolveApprovedContinuationCapture(
    parentOperation: PaymentOperation,
    input: CaptureCheckoutOrderRequest,
    checkoutOp: PaymentOperation,
    scope: string,
    fingerprint: string,
  ): Promise<{ operation: PaymentOperation; claimedForExecution: boolean }> {
    const child = await this.store.createOperation({
      idempotencyKey: approvedOnceContinuationKey(input.idempotencyKey),
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'capture',
      correlationId: input.correlationId ?? null,
      parentOperationId: parentOperation.operationId,
      providerOrderId: input.providerOrderId,
      amountMinor: checkoutOp.amountMinor,
      currencyCode: checkoutOp.currencyCode,
    });

    if (child.status === 'succeeded') {
      return { operation: child, claimedForExecution: false };
    }

    if (child.status === 'prepared') {
      try {
        const claimed = await this.store.claimOperationForExecution({
          operationId: child.operationId,
          expectedVersion: child.version,
        });
        return { operation: claimed, claimedForExecution: true };
      } catch (error) {
        if (
          error instanceof PaymentReliabilityError &&
          error.code === PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT
        ) {
          const refreshed = await this.store.findOperationById(child.operationId);
          return { operation: refreshed ?? child, claimedForExecution: false };
        }
        throw error;
      }
    }

    if (child.status === 'unknown') {
      const claimed = await this.claimUnknownCaptureRetry(child);
      return { operation: claimed ?? child, claimedForExecution: claimed != null };
    }

    return { operation: child, claimedForExecution: false };
  }

  private isCheckoutExecutorPersistenceConflict(error: unknown): boolean {
    if (!(error instanceof PaymentReliabilityError)) {
      return false;
    }
    if (error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT) {
      return true;
    }
    return (
      error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED &&
      error.rejectionReason === PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH
    );
  }

  private async reloadCheckoutOperationAfterPersistenceConflict(
    operationId: string,
  ): Promise<PaymentOperation> {
    const reloaded = await this.store.findOperationById(operationId);
    if (!reloaded) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Operation was not found after persistence conflict',
      );
    }
    return reloaded;
  }

  private async persistCheckoutCreateExecutionTransition(
    operation: PaymentOperation,
    executionOwnerToken: string,
    input: Omit<
      Parameters<PaymentReliabilityStore['transitionOperation']>[0],
      | 'operationId'
      | 'expectedVersion'
      | 'expectedExecutionOwnerToken'
      | 'executionOwnerToken'
      | 'executionLeaseExpiresAt'
    >,
  ): Promise<PaymentOperation> {
    try {
      return await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        expectedExecutionOwnerToken: executionOwnerToken,
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        ...input,
      });
    } catch (error) {
      if (!this.isCheckoutExecutorPersistenceConflict(error)) {
        throw error;
      }
      return this.reloadCheckoutOperationAfterPersistenceConflict(operation.operationId);
    }
  }

  private async handleProviderFailure(
    operation: PaymentOperation,
    error: unknown,
    executionOwnerToken?: string | null,
  ): Promise<PaymentOperation> {
    const resolved = resolveProviderFailure(error);
    const nextStatus =
      resolved.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED
        ? 'failed'
        : resolved.uncertain || resolved.retryable
          ? 'unknown'
          : isTerminalPreProviderFailureCode(resolved.code) ||
              resolved.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION
            ? 'failed'
            : 'unknown';

    const ownerToken = executionOwnerToken ?? operation.executionOwnerToken;
    const transitionInput = {
      operationId: operation.operationId,
      expectedVersion: operation.version,
      ...(ownerToken
        ? {
            expectedExecutionOwnerToken: ownerToken,
            executionOwnerToken: null,
            executionLeaseExpiresAt: null,
          }
        : {}),
      nextStatus,
      failureCode: resolved.code,
      failureMessage: resolved.message,
      reason: 'Provider mutation returned uncertain or terminal outcome',
    } as Parameters<PaymentReliabilityStore['transitionOperation']>[0];

    try {
      return await this.store.transitionOperation(transitionInput);
    } catch (transitionError) {
      if (ownerToken && this.isCheckoutExecutorPersistenceConflict(transitionError)) {
        return this.reloadCheckoutOperationAfterPersistenceConflict(operation.operationId);
      }
      throw transitionError;
    }
  }
}
