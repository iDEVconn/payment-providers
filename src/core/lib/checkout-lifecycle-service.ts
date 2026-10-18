import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CaptureCheckoutOrderRequest,
  type CheckoutCaptureResult,
  type CheckoutOrderResult,
  type CheckoutOrderStatus,
  type CreateCheckoutOrderRequest,
  type ExecuteGetCheckoutOrderResult,
  type GetCheckoutOrderRequest,
  type PaymentOperation,
  type RefundCaptureRequest,
  type RefundCaptureResult,
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
  return {
    operationId: operation.operationId,
    operationStatus: operation.status,
    providerOrderId: operation.providerOrderId ?? providerOrderIdOverride ?? null,
    checkoutStatus:
      operation.status === 'succeeded'
        ? 'created'
        : operation.status === 'failed'
          ? 'failed'
          : operation.status === 'unknown'
            ? 'unknown'
            : 'created',
    amount: {
      currency: operation.currencyCode ?? 'USD',
      amountMinor: operation.amountMinor ?? '0',
    },
    approvalUrl: operation.approvalUrl,
    correlationId: operation.correlationId,
  };
}

function toCaptureResult(
  operation: PaymentOperation,
  checkoutOperationId: string,
  captureStatusOverride?: CheckoutOrderStatus,
): CheckoutCaptureResult {
  return {
    operationId: operation.operationId,
    operationStatus: operation.status,
    checkoutOperationId,
    providerOrderId: operation.providerOrderId ?? '',
    providerCaptureId: operation.providerCaptureId,
    captureStatus:
      captureStatusOverride ??
      (operation.status === 'succeeded'
        ? 'captured'
        : operation.status === 'failed'
          ? 'failed'
          : operation.status === 'unknown'
            ? 'unknown'
            : 'approved'),
    amount:
      operation.amountMinor && operation.currencyCode
        ? { amountMinor: operation.amountMinor, currency: operation.currencyCode }
        : null,
    correlationId: operation.correlationId,
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

export class CheckoutLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: CheckoutProviderPort,
  ) {}

  async createCheckoutOrder(input: CreateCheckoutOrderRequest): Promise<CheckoutOrderResult> {
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
      return toCheckoutOrderResult(operation);
    }
    if (operation.status === 'submitted' || operation.status === 'unknown') {
      return toCheckoutOrderResult(operation);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

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

      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'submitted',
        providerReferenceId: providerResult.providerOrderId,
        providerOrderId: providerResult.providerOrderId,
        approvalUrl: providerResult.approvalUrl,
        amountMinor: providerResult.amount.amountMinor,
        currencyCode: providerResult.amount.currency,
        reason: 'Checkout order created at provider',
      });
    } catch (error) {
      if (providerResult?.providerOrderId) {
        try {
          operation = await this.store.transitionOperation({
            operationId: operation.operationId,
            expectedVersion: operation.version,
            nextStatus: 'unknown',
            providerReferenceId: providerResult.providerOrderId,
            providerOrderId: providerResult.providerOrderId,
            approvalUrl: providerResult.approvalUrl,
            amountMinor: providerResult.amount.amountMinor,
            currencyCode: providerResult.amount.currency,
            reason: 'Provider checkout created; local persistence uncertain',
          });
        } catch {
          operation = {
            ...operation,
            providerOrderId: providerResult.providerOrderId,
            approvalUrl: providerResult.approvalUrl,
          };
        }
      } else {
        operation = await this.handleProviderFailure(operation, error);
      }
    }

    return toCheckoutOrderResult(operation, providerResult?.providerOrderId ?? null);
  }

  async getCheckoutOrder(input: GetCheckoutOrderRequest): Promise<CheckoutOrderResult> {
    const operation = await this.store.findOperationByProviderOrderId(
      input.providerCode,
      input.accountRef,
      input.environment,
      input.providerOrderId,
    );

    const providerResult = await this.provider.getOrder({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerOrderId: input.providerOrderId,
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
      return {
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
      };
    }

    return {
      operationId: '',
      operationStatus: 'prepared',
      providerOrderId: providerResult.providerOrderId,
      checkoutStatus: providerResult.checkoutStatus,
      amount: providerResult.amount ?? { currency: 'USD', amountMinor: '0' },
      approvalUrl: providerResult.approvalUrl,
      correlationId: null,
      providerDebugId: providerResult.providerDebugId ?? null,
    };
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
        return toCaptureResult(executingOperation, checkoutOp.operationId, 'created');
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

  private async handleProviderFailure(
    operation: PaymentOperation,
    error: unknown,
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

    return this.store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus,
      failureCode: resolved.code,
      failureMessage: resolved.message,
      reason: 'Provider mutation returned uncertain or terminal outcome',
    });
  }
}
