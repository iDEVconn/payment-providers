import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CaptureMarketplaceOrderRequest,
  type CreateMarketplaceOrderRequest,
  type GetMarketplaceOrderRequest,
  type MarketplaceOrderResult,
  type MarketplacePurchaseUnitRecord,
  type MarketplaceUnitResult,
  type PaymentOperation,
  type RefundMarketplaceUnitRequest,
  type RefundMarketplaceUnitResult,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import { validateCanonicalMoney, validateOptionalRefundAmount } from './money';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import {
  applyMarketplaceUnitSnapshots,
  resolveMarketplaceStatusFromOrder,
} from './marketplace-evidence-application';
import type { MarketplaceProviderPort } from './marketplace-provider-port';
import {
  ensureSellerReadyForMarketplace,
  type MarketplaceSellerReadinessClock,
} from './marketplace-seller-precondition';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import type { SellerConnectionReconciliationLookup } from './seller-connection-reconciliation';

function toUnitResult(unit: MarketplacePurchaseUnitRecord): MarketplaceUnitResult {
  return {
    referenceId: unit.referenceId,
    sellerRef: unit.sellerRef,
    providerMerchantId: unit.providerMerchantId,
    unitStatus: unit.unitStatus,
    amount: { currency: unit.currencyCode, amountMinor: unit.amountMinor },
    platformFee:
      unit.platformFeeMinor && unit.platformFeeCurrency
        ? { currency: unit.platformFeeCurrency, amountMinor: unit.platformFeeMinor }
        : null,
    providerCaptureId: unit.providerCaptureId,
    providerFee:
      unit.providerFeeMinor && unit.providerFeeCurrency
        ? { currency: unit.providerFeeCurrency, amountMinor: unit.providerFeeMinor }
        : null,
    netAmount: unit.netAmountMinor
      ? { currency: unit.currencyCode, amountMinor: unit.netAmountMinor }
      : null,
    refundedAmount: { currency: unit.currencyCode, amountMinor: unit.refundedMinor },
  };
}

function toOrderResult(
  operation: PaymentOperation,
  units: MarketplacePurchaseUnitRecord[],
  marketplaceStatus: MarketplaceOrderResult['marketplaceStatus'],
): MarketplaceOrderResult {
  return {
    operationId: operation.operationId,
    operationStatus: operation.status,
    providerOrderId: operation.providerOrderId,
    marketplaceStatus,
    approvalUrl: operation.approvalUrl,
    units: units.map(toUnitResult),
    correlationId: operation.correlationId,
  };
}

function validateUnits(
  input: CreateMarketplaceOrderRequest['units'],
): CreateMarketplaceOrderRequest['units'] {
  if (input.length < 1 || input.length > 10) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Marketplace checkout requires between 1 and 10 purchase units',
    );
  }
  const references = new Set<string>();
  let currency: string | null = null;
  const validated = input.map((unit) => {
    const referenceId = unit.referenceId.trim();
    if (!referenceId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Each purchase unit requires a referenceId',
      );
    }
    if (references.has(referenceId)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Duplicate purchase unit referenceId',
      );
    }
    references.add(referenceId);
    const amount = validateCanonicalMoney(unit.amount);
    if (currency == null) {
      currency = amount.currency;
    } else if (currency !== amount.currency) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'All purchase units must share one currency',
      );
    }
    const platformFee = unit.platformFee ? validateCanonicalMoney(unit.platformFee) : null;
    if (platformFee && platformFee.currency !== amount.currency) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Platform fee currency must match unit amount currency',
      );
    }
    if (platformFee && BigInt(platformFee.amountMinor) >= BigInt(amount.amountMinor)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Platform fee must be strictly less than unit amount',
      );
    }
    return {
      sellerRef: unit.sellerRef.trim(),
      referenceId,
      amount,
      platformFee,
    };
  });
  return validated;
}

export class MarketplaceLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: MarketplaceProviderPort,
    private readonly sellerRecon: SellerConnectionReconciliationLookup,
    private readonly sellerReadiness: MarketplaceSellerReadinessClock = {},
  ) {}

  async createMarketplaceOrder(
    input: CreateMarketplaceOrderRequest,
  ): Promise<MarketplaceOrderResult> {
    const units = validateUnits(input.units);
    const resolvedUnits = [];
    for (const unit of units) {
      const ready = await ensureSellerReadyForMarketplace({
        store: this.store,
        sellerRecon: this.sellerRecon,
        applicationRef: input.applicationRef,
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        environment: input.environment,
        sellerRef: unit.sellerRef,
        now: this.sellerReadiness.now,
        maxAgeMs: this.sellerReadiness.maxAgeMs,
      });
      resolvedUnits.push({
        ...unit,
        providerMerchantId: ready.providerMerchantId,
      });
    }

    const fingerprint = buildCommandFingerprint({
      units: resolvedUnits.map((unit) => ({
        sellerRef: unit.sellerRef,
        referenceId: unit.referenceId,
        amount: unit.amount,
        platformFee: unit.platformFee,
      })),
      returnUrl: input.returnUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'marketplace_checkout',
    });
    const existing = await this.store.findOperationByIdempotency(scope, input.idempotencyKey);
    if (existing) {
      if (existing.commandFingerprint !== fingerprint) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
          'Idempotency key was reused with a different marketplace payload',
        );
      }
      const storedUnits = await this.store.listMarketplacePurchaseUnits(existing.operationId);
      return toOrderResult(existing, storedUnits, 'created');
    }

    const operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'marketplace_checkout',
      correlationId: input.correlationId ?? null,
      currencyCode: resolvedUnits[0]?.amount.currency ?? null,
    });

    await this.store.insertMarketplacePurchaseUnits(
      resolvedUnits.map((unit) => ({
        operationId: operation.operationId,
        referenceId: unit.referenceId,
        sellerRef: unit.sellerRef,
        providerMerchantId: unit.providerMerchantId,
        amountMinor: unit.amount.amountMinor,
        currencyCode: unit.amount.currency,
        platformFeeMinor: unit.platformFee?.amountMinor ?? null,
        platformFeeCurrency: unit.platformFee?.currency ?? null,
        unitStatus: 'pending',
      })),
    );

    const claimed = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const providerResult = await this.provider.createOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: claimed.operationId,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
        units: resolvedUnits.map((unit) => ({
          referenceId: unit.referenceId,
          providerMerchantId: unit.providerMerchantId,
          amount: unit.amount,
          platformFee: unit.platformFee,
        })),
      });

      const updated = await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus: 'submitted',
        providerOrderId: providerResult.providerOrderId,
        approvalUrl: providerResult.approvalUrl,
        reason: 'marketplace order created at provider',
      });

      if (providerResult.units.length > 0) {
        await applyMarketplaceUnitSnapshots({
          store: this.store,
          operationId: updated.operationId,
          snapshots: providerResult.units,
          preserveCaptured: true,
        });
      }

      const storedUnits = await this.store.listMarketplacePurchaseUnits(updated.operationId);
      return toOrderResult(updated, storedUnits, providerResult.marketplaceStatus);
    } catch (error) {
      await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus: 'failed',
        failureCode:
          (error as { code?: string }).code ??
          PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        failureMessage: error instanceof Error ? error.message : 'Marketplace create failed',
        reason: 'marketplace create failed at provider',
      });
      throw error;
    }
  }

  async getMarketplaceOrder(input: GetMarketplaceOrderRequest): Promise<MarketplaceOrderResult> {
    const operation = await this.store.findOperationById(input.marketplaceOperationId);
    if (!operation || operation.kind !== 'marketplace_checkout') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Marketplace checkout operation was not found',
      );
    }
    const units = await this.store.listMarketplacePurchaseUnits(operation.operationId);
    if (!operation.providerOrderId) {
      return toOrderResult(operation, units, 'created');
    }

    const lookup = await this.provider.getOrder({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerOrderId: operation.providerOrderId,
    });
    const updatedUnits = await applyMarketplaceUnitSnapshots({
      store: this.store,
      operationId: operation.operationId,
      snapshots: lookup.units,
      preserveCaptured: true,
    });
    const marketplaceStatus = resolveMarketplaceStatusFromOrder(
      lookup.marketplaceStatus,
      updatedUnits.map((unit) => unit.unitStatus),
    );
    return toOrderResult(operation, updatedUnits, marketplaceStatus);
  }

  async captureMarketplaceOrder(
    input: CaptureMarketplaceOrderRequest,
  ): Promise<MarketplaceOrderResult> {
    const checkout = await this.store.findOperationById(input.marketplaceOperationId);
    if (!checkout || checkout.kind !== 'marketplace_checkout') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Marketplace checkout operation was not found',
      );
    }

    const fingerprint = buildCommandFingerprint({
      marketplaceOperationId: input.marketplaceOperationId,
      providerOrderId: input.providerOrderId,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'marketplace_capture',
    });
    const existing = await this.store.findOperationByIdempotency(scope, input.idempotencyKey);
    if (existing) {
      if (existing.commandFingerprint !== fingerprint) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
          'Idempotency key was reused with a different marketplace capture payload',
        );
      }
      const parentUnits = await this.store.listMarketplacePurchaseUnits(checkout.operationId);
      return toOrderResult(
        checkout,
        parentUnits,
        resolveMarketplaceStatusFromOrder(
          'unknown',
          parentUnits.map((u) => u.unitStatus),
        ),
      );
    }

    const captureOp = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'marketplace_capture',
      parentOperationId: checkout.operationId,
      correlationId: input.correlationId ?? null,
      providerOrderId: input.providerOrderId,
    });

    const claimed = await this.store.claimOperationForExecution({
      operationId: captureOp.operationId,
      expectedVersion: captureOp.version,
    });

    try {
      const providerResult = await this.provider.captureOrder({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: claimed.operationId,
        providerOrderId: input.providerOrderId,
      });

      const updatedUnits = await applyMarketplaceUnitSnapshots({
        store: this.store,
        operationId: checkout.operationId,
        snapshots: providerResult.units,
        preserveCaptured: true,
      });
      const marketplaceStatus = resolveMarketplaceStatusFromOrder(
        providerResult.marketplaceStatus,
        updatedUnits.map((unit) => unit.unitStatus),
      );

      const nextStatus =
        marketplaceStatus === 'captured'
          ? 'succeeded'
          : marketplaceStatus === 'failed'
            ? 'failed'
            : marketplaceStatus === 'partially_captured'
              ? 'unknown'
              : providerResult.httpStatus >= 500 || providerResult.httpStatus === 504
                ? 'unknown'
                : 'unknown';

      await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus,
        reason: 'marketplace capture attempted',
      });

      return toOrderResult(checkout, updatedUnits, marketplaceStatus);
    } catch (error) {
      const err = error as { code?: string; retryable?: boolean; uncertain?: boolean };
      await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus: err.retryable || err.uncertain ? 'unknown' : 'failed',
        failureCode: err.code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        failureMessage: error instanceof Error ? error.message : 'Marketplace capture failed',
        reason: 'marketplace capture failed at provider',
      });
      throw error;
    }
  }

  async refundMarketplaceUnit(
    input: RefundMarketplaceUnitRequest,
  ): Promise<RefundMarketplaceUnitResult> {
    const checkout = await this.store.findOperationById(input.marketplaceOperationId);
    if (!checkout || checkout.kind !== 'marketplace_checkout') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Marketplace checkout operation was not found',
      );
    }
    const unit = await this.store.findMarketplacePurchaseUnitByReference(
      checkout.operationId,
      input.referenceId,
    );
    if (!unit || unit.providerCaptureId !== input.providerCaptureId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Marketplace purchase unit capture was not found',
      );
    }

    const amount = validateOptionalRefundAmount(input.amount);
    const platformFeeRefund = validateOptionalRefundAmount(input.platformFeeRefund);
    if (
      platformFeeRefund &&
      unit.platformFeeMinor &&
      BigInt(platformFeeRefund.amountMinor) > BigInt(unit.platformFeeMinor)
    ) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Platform fee refund exceeds captured platform fee',
      );
    }

    const fingerprint = buildCommandFingerprint({
      marketplaceOperationId: input.marketplaceOperationId,
      referenceId: input.referenceId,
      providerCaptureId: input.providerCaptureId,
      amount,
      platformFeeRefund,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'marketplace_refund',
    });
    const existing = await this.store.findOperationByIdempotency(scope, input.idempotencyKey);
    if (existing) {
      if (existing.commandFingerprint !== fingerprint) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
          'Idempotency key was reused with a different marketplace refund payload',
        );
      }
      return {
        operationId: existing.operationId,
        operationStatus: existing.status,
        marketplaceOperationId: checkout.operationId,
        referenceId: input.referenceId,
        providerCaptureId: input.providerCaptureId,
        providerRefundId: existing.providerRefundId,
        refundStatus:
          existing.status === 'succeeded'
            ? 'completed'
            : existing.status === 'failed'
              ? 'failed'
              : existing.status === 'unknown'
                ? 'unknown'
                : 'pending',
        amount:
          existing.amountMinor && existing.currencyCode
            ? { amountMinor: existing.amountMinor, currency: existing.currencyCode }
            : null,
        correlationId: existing.correlationId,
      };
    }

    const refundMinor = amount?.amountMinor ?? unit.amountMinor;
    const reserved = BigInt(unit.refundedMinor) + BigInt(refundMinor);
    if (reserved > BigInt(unit.amountMinor)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Refund would exceed captured unit amount',
      );
    }

    const refundOp = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'marketplace_refund',
      parentOperationId: checkout.operationId,
      correlationId: input.correlationId ?? null,
      providerCaptureId: input.providerCaptureId,
      amountMinor: refundMinor,
      currencyCode: unit.currencyCode,
      itemRef: input.referenceId,
    });

    const claimed = await this.store.claimOperationForExecution({
      operationId: refundOp.operationId,
      expectedVersion: refundOp.version,
    });

    try {
      const providerResult = await this.provider.refundUnit({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: claimed.operationId,
        providerCaptureId: input.providerCaptureId,
        amount,
        platformFeeRefund,
      });

      const updated = await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus: providerResult.refundStatus === 'completed' ? 'succeeded' : 'unknown',
        providerRefundId: providerResult.providerRefundId,
        reason: 'marketplace unit refund submitted',
      });

      await this.store.updateMarketplacePurchaseUnit({
        unitId: unit.unitId,
        expectedVersion: unit.version,
        refundedMinor: reserved.toString(),
        unitStatus: reserved === BigInt(unit.amountMinor) ? 'refunded' : 'partially_refunded',
      });

      return {
        operationId: updated.operationId,
        operationStatus: updated.status,
        marketplaceOperationId: checkout.operationId,
        referenceId: input.referenceId,
        providerCaptureId: input.providerCaptureId,
        providerRefundId: providerResult.providerRefundId,
        refundStatus: providerResult.refundStatus,
        amount: providerResult.amount,
        correlationId: updated.correlationId,
      };
    } catch (error) {
      await this.store.transitionOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.version,
        nextStatus: 'unknown',
        failureCode:
          (error as { code?: string }).code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        failureMessage: error instanceof Error ? error.message : 'Marketplace refund failed',
        reason: 'marketplace refund failed at provider',
      });
      throw error;
    }
  }
}
