import type {
  CreatePaymentOperationInput,
  CreateSellerConnectionInput,
  InsertMarketplacePurchaseUnitInput,
  InsertProviderEvidenceInput,
  InsertReconciliationAttemptInput,
  MarketplacePurchaseUnitRecord,
  PaymentOperation,
  PaymentOperationTransitionRecord,
  ProviderEvidenceRecord,
  ReconciliationAttempt,
  SellerConnectionRecord,
  TransitionPaymentOperationInput,
  UpdateMarketplacePurchaseUnitInput,
  UpdatePaymentOperationInput,
  UpdateProviderEvidenceInput,
  UpdateSellerConnectionInput,
} from '../../../contracts/index';

export interface PaymentReliabilityStore {
  createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation>;
  findOperationById(operationId: string): Promise<PaymentOperation | null>;
  findOperationByIdempotency(
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderReference(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferenceId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderOrderId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerOrderId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderCaptureId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerCaptureId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderRefundId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerRefundId: string,
  ): Promise<PaymentOperation | null>;
  findOperationBySenderBatchId(
    providerCode: string,
    accountRef: string,
    environment: string,
    senderBatchId: string,
  ): Promise<PaymentOperation | null>;
  findOperationBySenderItemId(
    providerCode: string,
    accountRef: string,
    environment: string,
    senderItemId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderPayoutBatchId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPayoutBatchId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderPayoutItemId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPayoutItemId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderProductId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerProductId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderPlanId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPlanId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderSubscriptionId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerSubscriptionId: string,
  ): Promise<PaymentOperation | null>;
  findOperationByProviderReferralId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferralId: string,
  ): Promise<PaymentOperation | null>;
  claimOperationForExecution(input: {
    operationId: string;
    expectedVersion: number;
  }): Promise<PaymentOperation>;
  updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation>;
  transitionOperation(input: TransitionPaymentOperationInput): Promise<PaymentOperation>;
  listOperationTransitions(operationId: string): Promise<PaymentOperationTransitionRecord[]>;

  insertEvidence(input: InsertProviderEvidenceInput): Promise<ProviderEvidenceRecord>;
  findEvidenceById(evidenceId: string): Promise<ProviderEvidenceRecord | null>;
  findEvidenceByProviderEvent(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerEventId: string,
  ): Promise<ProviderEvidenceRecord | null>;
  updateEvidence(input: UpdateProviderEvidenceInput): Promise<ProviderEvidenceRecord>;
  claimPendingEvidence(input: {
    limit: number;
    leaseMs: number;
    workerId: string;
  }): Promise<ProviderEvidenceRecord[]>;
  listReconciliationCandidates(limit: number): Promise<ProviderEvidenceRecord[]>;
  listUncertainOperations(limit: number): Promise<PaymentOperation[]>;
  listOperationsByParent(parentOperationId: string): Promise<PaymentOperation[]>;
  reserveRefundCapacity(input: {
    captureOperationId: string;
    requestedAmountMinor: string;
    excludeOperationId?: string;
  }): Promise<void>;

  insertReconciliationAttempt(
    input: InsertReconciliationAttemptInput,
  ): Promise<ReconciliationAttempt>;

  createSellerConnection(input: CreateSellerConnectionInput): Promise<SellerConnectionRecord>;
  findSellerConnectionById(connectionId: string): Promise<SellerConnectionRecord | null>;
  findSellerConnectionBySellerRef(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    sellerRef: string,
  ): Promise<SellerConnectionRecord | null>;
  findSellerConnectionByMerchantId(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    providerMerchantId: string,
  ): Promise<SellerConnectionRecord | null>;
  findSellerConnectionByReferralId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferralId: string,
  ): Promise<SellerConnectionRecord | null>;
  findSellerConnectionByTrackingId(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    trackingId: string,
  ): Promise<SellerConnectionRecord | null>;
  updateSellerConnection(input: UpdateSellerConnectionInput): Promise<SellerConnectionRecord>;
  listSellerConnectionsForReconciliation(limit: number): Promise<SellerConnectionRecord[]>;

  insertMarketplacePurchaseUnits(
    units: InsertMarketplacePurchaseUnitInput[],
  ): Promise<MarketplacePurchaseUnitRecord[]>;
  listMarketplacePurchaseUnits(operationId: string): Promise<MarketplacePurchaseUnitRecord[]>;
  findMarketplacePurchaseUnitById(unitId: string): Promise<MarketplacePurchaseUnitRecord | null>;
  findMarketplacePurchaseUnitByReference(
    operationId: string,
    referenceId: string,
  ): Promise<MarketplacePurchaseUnitRecord | null>;
  findMarketplacePurchaseUnitByCaptureId(
    providerCaptureId: string,
  ): Promise<MarketplacePurchaseUnitRecord | null>;
  updateMarketplacePurchaseUnit(
    input: UpdateMarketplacePurchaseUnitInput,
  ): Promise<MarketplacePurchaseUnitRecord>;
  findLatestReconciliationEvidenceForResource(input: {
    applicationRef: string;
    providerCode: string;
    accountRef: string;
    environment: string;
    resourceId: string;
  }): Promise<ProviderEvidenceRecord | null>;
}
