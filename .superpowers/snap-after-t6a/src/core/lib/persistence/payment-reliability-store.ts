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
  ClaimPendingEvidenceInput,
  ListPaymentEvidenceForRecoveryInput,
  ListPaymentEvidenceForRecoveryResult,
} from '../../../contracts/index';

/*
 * Store contract, split by capability (issue #6). A host implements the interfaces of the flows it
 * uses: `SubscriptionStore` is enough for subscriptions (lifecycle, webhooks, reconciliation and
 * recovery). `PaymentReliabilityStore` is the union of every capability.
 *
 * Guarantees every implementation must give (checked by `runStoreConformance` from
 * `@idevconn/payment-providers/testing`; the in-memory store is the reference):
 *
 * - Errors are `PaymentReliabilityError` with the codes named below: services branch on `code`.
 * - Patch semantics for every optional field of an update/transition input: `undefined` keeps the
 *   stored value, `null` clears it. Exceptions are listed on the method.
 * - `subscriptionStateJson` (one nullable text/jsonb column) is stored verbatim by create, update
 *   and transition and returned on every read; the engine keeps the subscription reducer state
 *   there (last payment, failed-payment count, recent ids, undelivered effects).
 * - Each successful write of an operation increments `version` by exactly 1 and sets `updatedAt`.
 * - Methods that check `expectedVersion` are compare-and-set: on a mismatch they change nothing.
 *   Two concurrent calls with the same `expectedVersion` never both succeed (SQL:
 *   `UPDATE ... WHERE operation_id = $1 AND version = $2`, zero rows = conflict).
 * - Concurrency is the store's job: the services run in several workers at once.
 */

export type AcquireCheckoutCreateExecutionLeaseResult =
  | {
      kind: 'acquired';
      operation: PaymentOperation;
      executionOwnerToken: string;
    }
  | { kind: 'in_flight'; operation: PaymentOperation }
  | { kind: 'not_eligible'; operation: PaymentOperation };

/** Operations, their compare-and-set updates and the transition history. */
export interface OperationStore {
  /**
   * Inserts an operation in `prepared` with `version` 1, or returns the existing row for the same
   * `(idempotencyScope, idempotencyKey)` when its `commandFingerprint` is equal. A different
   * fingerprint throws `IDEMPOTENCY_CONFLICT`. Concurrent creates with one key return one row
   * (SQL: unique index + `INSERT ... ON CONFLICT DO NOTHING`, then re-select). Provider ids are
   * bound as in `transitionOperation`.
   */
  createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation>;
  findOperationById(operationId: string): Promise<PaymentOperation | null>;
  findOperationByIdempotency(
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PaymentOperation | null>;
  /**
   * `providerReferenceId` is unique per `(providerCode, accountRef, environment)` across all kinds:
   * binding an id held by another operation throws `TRANSITION_REJECTED` with rejection reason
   * `PROVIDER_REFERENCE_BOUND`.
   */
  findOperationByProviderReference(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferenceId: string,
  ): Promise<PaymentOperation | null>;
  /**
   * Compare-and-set `prepared -> submitted` at `expectedVersion`. Throws `OPERATION_CONFLICT` when
   * the row is missing, the version differs or the status is not `prepared`; of two concurrent
   * claims exactly one wins. Writes the history row with `transitionKind: 'claim_execution'`
   * (the reason text is free).
   */
  claimOperationForExecution(input: {
    operationId: string;
    expectedVersion: number;
  }): Promise<PaymentOperation>;
  /**
   * Compare-and-set field patch at `expectedVersion` (`TRANSITION_CONFLICT` on a mismatch). No
   * status change and no history row. `undefined` keeps, `null` clears; a cleared provider id no
   * longer matches its lookup. Provider ids are bound as in `transitionOperation`.
   */
  updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation>;
  /**
   * Status change plus field patch at `expectedVersion`, and exactly one history row, in ONE
   * transaction: when any check fails nothing is written. Checks, in order: version
   * (`TRANSITION_CONFLICT`), `expectedExecutionOwnerToken` when given (`TRANSITION_REJECTED`,
   * `EXECUTION_OWNER_MISMATCH`), provider ids bound to another operation (`TRANSITION_REJECTED`,
   * `PROVIDER_REFERENCE_BOUND`), then `assertTransitionAllowed` (`TRANSITION_REJECTED`).
   *
   * Provider ids unique per `(providerCode, accountRef, environment)`: `providerReferenceId` (any
   * kind), `providerSubscriptionId` among `subscription` operations, `providerPlanId` among
   * `billing_plan`, `providerProductId` among `catalog_product`, `providerReferralId` among
   * `seller_referral` (SQL: partial unique indexes).
   *
   * Patch exceptions: `providerReferenceId` keeps the stored value for `null` as well (a transition
   * never unbinds a reference). `failureCode`/`failureMessage` follow the general rule (`null`
   * clears). The history row stores `reason`, `evidenceId` and `transitionKind` (`null` when absent).
   */
  transitionOperation(input: TransitionPaymentOperationInput): Promise<PaymentOperation>;
  /** History rows of one operation, oldest first. */
  listOperationTransitions(operationId: string): Promise<PaymentOperationTransitionRecord[]>;
}

/** Create execution lease for checkout and subscription creates (single provider call in flight). */
export interface CreateExecutionLeaseStore {
  /**
   * For a `checkout` or `subscription` operation without a provider create reference: when no
   * unexpired lease is held and the status is `prepared`, `unknown` or `submitted` (with an expired
   * or missing lease), moves it to `submitted` with a new owner token and lease expiry and returns
   * `acquired`. The history row has `transitionKind` `claim_execution` from `prepared`,
   * `claim_retry` otherwise. An unexpired lease gives `in_flight` (also when `expectedVersion` is
   * stale); a provider reference or a terminal status gives `not_eligible`; another stale version
   * throws `OPERATION_CONFLICT`. Of two concurrent calls at most one is `acquired`.
   */
  acquireCheckoutCreateExecutionLease(input: {
    operationId: string;
    expectedVersion: number;
  }): Promise<AcquireCheckoutCreateExecutionLeaseResult>;
}

/** Kind-scoped lookups for catalog products, billing plans and subscriptions. */
export interface SubscriptionOperationLookupStore {
  /** Only `catalog_product` operations. */
  findOperationByProviderProductId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerProductId: string,
  ): Promise<PaymentOperation | null>;
  /** Only `billing_plan` operations. */
  findOperationByProviderPlanId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerPlanId: string,
  ): Promise<PaymentOperation | null>;
  /** Only `subscription` operations (lifecycle command operations are not returned). */
  findOperationByProviderSubscriptionId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerSubscriptionId: string,
  ): Promise<PaymentOperation | null>;
}

/** Provider evidence inbox: webhooks and reconciliation lookups, with recovery leases. */
export interface EvidenceStore {
  /**
   * Inserts with `verificationStatus` and `processingStatus` `pending`. `providerEventId` is unique
   * per `(providerCode, accountRef, environment)`: a duplicate throws `EVIDENCE_DUPLICATE`, also
   * for concurrent inserts (one wins).
   */
  insertEvidence(input: InsertProviderEvidenceInput): Promise<ProviderEvidenceRecord>;
  findEvidenceById(evidenceId: string): Promise<ProviderEvidenceRecord | null>;
  findEvidenceByProviderEvent(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerEventId: string,
  ): Promise<ProviderEvidenceRecord | null>;
  /**
   * Field patch, `undefined` keeps and `null` clears (`errorCode`, `errorMessage`, `processedAt`,
   * `relatedOperationId`, lease and consumer fields). The consumer-delivery fields
   * (`consumerDeliveryStatus`, `consumerDeliveredAt`, `consumerDeliveryAttempts`,
   * `consumerDeliveryLastError`) MUST be persisted and returned as written. No version check:
   * the recovery lease serialises writers.
   */
  updateEvidence(input: UpdateProviderEvidenceInput): Promise<ProviderEvidenceRecord>;
  /**
   * Leases up to `limit` recoverable rows (see `isRecoverableEvidenceRow`) whose lease is free,
   * expired or already held by `workerId`, oldest `receivedAt` first, and returns them with the
   * new lease (`claimWorkerId`, `claimLeaseExpiresAt` = now + `leaseMs`), sorted oldest first.
   * Two workers never get the same row while its lease is unexpired (SQL: `FOR UPDATE SKIP
   * LOCKED`, or a conditional per-row update; under contention a worker may then get fewer rows
   * than `limit`). In Postgres `UPDATE ... RETURNING` does not keep the subquery's `ORDER BY`:
   * sort the returned rows (CTE + outer `ORDER BY received_at, evidence_id`).
   *
   * `includeConsumerDelivery: false` MUST skip rows that only await consumer delivery: recovery
   * passes it when no consumer is configured, and a store that ignores it fills every batch with
   * those rows (oldest first), so newer verified rows are never processed.
   * A blank `workerId` throws `INVALID_REQUEST`.
   */
  claimPendingEvidence(input: ClaimPendingEvidenceInput): Promise<ProviderEvidenceRecord[]>;
}

/** Candidates for `ReconciliationService` and its attempt log. */
export interface ReconciliationStore {
  /**
   * Verified evidence that is `unmatched` or whose related operation is `unknown`, oldest
   * `receivedAt` first (`ORDER BY received_at, evidence_id`), at most `limit` rows.
   */
  listReconciliationCandidates(limit: number): Promise<ProviderEvidenceRecord[]>;
  /** Operations in `unknown`, oldest `createdAt` first (`ORDER BY created_at, operation_id`). */
  listUncertainOperations(limit: number): Promise<PaymentOperation[]>;
  insertReconciliationAttempt(
    input: InsertReconciliationAttemptInput,
  ): Promise<ReconciliationAttempt>;
}

/**
 * Everything a subscriptions-only host implements. `SubscriptionLifecycleService`,
 * `WebhookProcessingService`, `ReconciliationService` and `PaymentRecoveryService` run with it;
 * webhook and reconciliation paths of other families detect the missing capability and record the
 * evidence as `unsupported` (or a no-op attempt) instead of calling a missing method.
 */
export interface SubscriptionStore
  extends
    OperationStore,
    CreateExecutionLeaseStore,
    SubscriptionOperationLookupStore,
    EvidenceStore,
    ReconciliationStore {}

/** One-off checkout, capture and refund flows. Provider ids here are not unique (latest row wins). */
export interface CheckoutStore extends CreateExecutionLeaseStore {
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
  /** Throws `INVALID_REQUEST` when the refund exceeds the capture's remaining balance. */
  reserveRefundCapacity(input: {
    captureOperationId: string;
    requestedAmountMinor: string;
    excludeOperationId?: string;
  }): Promise<void>;
}

/** Payout batches and items. */
export interface PayoutStore {
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
  /** Child operations (payout items of a batch, refunds of a capture). */
  listOperationsByParent(parentOperationId: string): Promise<PaymentOperation[]>;
}

/** Seller onboarding (partner referrals and seller connections). */
export interface SellerStore {
  /** Only `seller_referral` operations. */
  findOperationByProviderReferralId(
    providerCode: string,
    accountRef: string,
    environment: string,
    providerReferralId: string,
  ): Promise<PaymentOperation | null>;
  /** Returns the existing connection for the same seller ref instead of inserting a second one. */
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
  /** Compare-and-set at `expectedVersion` (`TRANSITION_CONFLICT`). */
  updateSellerConnection(input: UpdateSellerConnectionInput): Promise<SellerConnectionRecord>;
  /** Oldest `updatedAt` first. */
  listSellerConnectionsForReconciliation(limit: number): Promise<SellerConnectionRecord[]>;
}

/** Marketplace (multi-seller) checkout purchase units. */
export interface MarketplaceStore {
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
  /** Compare-and-set at `expectedVersion` (`TRANSITION_CONFLICT`). */
  updateMarketplacePurchaseUnit(
    input: UpdateMarketplacePurchaseUnitInput,
  ): Promise<MarketplacePurchaseUnitRecord>;
  /** Latest verified reconciliation evidence for a seller resource. */
  findLatestReconciliationEvidenceForResource(input: {
    applicationRef: string;
    providerCode: string;
    accountRef: string;
    environment: string;
    resourceId: string;
  }): Promise<ProviderEvidenceRecord | null>;
}

/** Admin listing of evidence for recovery screens. */
export interface EvidenceAdminStore {
  listProviderEvidenceForRecovery(
    input: ListPaymentEvidenceForRecoveryInput,
  ): Promise<ListPaymentEvidenceForRecoveryResult>;
}

/** Every capability: what `MemoryPaymentReliabilityStore` implements. */
export interface PaymentReliabilityStore
  extends
    SubscriptionStore,
    CheckoutStore,
    PayoutStore,
    SellerStore,
    MarketplaceStore,
    EvidenceAdminStore {}
