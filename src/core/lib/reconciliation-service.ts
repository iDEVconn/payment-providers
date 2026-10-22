import type {
  ExecuteGetSubscriptionResult,
  ExecuteMarketplaceUnitSnapshot,
  MarketplaceOrderStatus,
  PaymentOperation,
  PaymentOperationKind,
  PaymentOperationStatus,
  PayoutFinancialStatus,
  PlanStatus,
  ProviderEvidenceRecord,
  ReconcilePaymentOperationsResult,
  SubscriptionStatus,
} from '../../contracts/index';
import {
  DEFAULT_SUBMITTED_STALE_KINDS,
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
} from '../../contracts/index';
import { sanitizeOperationalErrorMessage } from './public-error-sanitizer';
import {
  CLEARED_RETRY_STATE,
  DEFAULT_SUBMITTED_STALE_AFTER_MS,
  clearResolvedOperationRetryState,
  hasRetryState,
  nextRetryDeferral,
  resolvePositiveDurationMs,
  resolveRetryBackoffPolicy,
  type RetryBackoffOptions,
  type RetryBackoffPolicy,
} from './retry-backoff';
import {
  assertTransitionAllowed,
  assertVerifiedEvidence,
  mapCheckoutWebhookEventToStatus,
} from './transition-policy';
import {
  mapPayoutWebhookEventToFinancialStatus,
  payoutFinancialStatusToOperationStatus,
} from './payout-transition-policy';
import { applyPayoutTransition, refreshPayoutBatchAggregate } from './payout-evidence-application';
import {
  buildPayoutTransitionProviderFields,
  correlatePayoutOperation,
  parsePaypalPayoutWebhookPayload,
} from './payout-webhook-correlation';
import {
  HELD_EFFECTS_OVERFLOW,
  SUBSCRIPTION_EFFECTS_HOOK_FAILED,
  SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP,
  applyPlanTransition,
  applySubscriptionEvents,
  deliverSubscriptionEffects,
  normalizeSubscriptionEvidencePayload,
  resolveExpectedSubscriptionPayment,
  subscriptionEventFromProviderSnapshot,
  type ApplySubscriptionEventsResult,
  type SubscriptionEffectsHooks,
  type SubscriptionEventStep,
} from './subscription-evidence-application';
import {
  isSubscriptionPaymentEvidenceEvent,
  mapPlanWebhookEventToStatus,
  planStatusToOperationStatus,
} from './subscription-transition-policy';
import { isSubscriptionEvidenceEvent } from './subscription-evidence-events';
import { isSellerOnboardingWebhookEvent } from './seller-transition-policy';
import { reconcileSellerConnectionAggregate } from './seller-connection-reconciliation';
import type { ReconciliationProviderLookup } from './checkout-provider-port';
import { applyMarketplaceUnitSnapshots } from './marketplace-evidence-application';
import type {
  MarketplaceStore,
  PayoutStore,
  SellerStore,
  SubscriptionStore,
} from './persistence/payment-reliability-store';
import {
  assertStoreCapabilitiesComplete,
  hasMarketplaceStore,
  hasPayoutStore,
  hasSellerStore,
} from './persistence/store-capabilities';
import { sha256Payload } from './sha256-payload';

type ReconcileCounters = ReconcilePaymentOperationsResult;

type ReconciliationOutcome = {
  executionStatus: PaymentOperationStatus | null;
  payoutStatus: PayoutFinancialStatus | null;
  planStatus?: PlanStatus | null;
  providerTransactionId?: string | null;
  providerFeeMinor?: string | null;
  providerFeeCurrency?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  referralActionUrl?: string | null;
  referralProviderReferralId?: string | null;
  marketplaceUnits?: ExecuteMarketplaceUnitSnapshot[];
  marketplaceCheckoutOperationId?: string;
};

type SubscriptionCommandKind =
  | 'subscription_cancel'
  | 'subscription_suspend'
  | 'subscription_activate';

/** The subscription status an accepted lifecycle command leads to. */
const SUBSCRIPTION_COMMAND_TARGET: Record<SubscriptionCommandKind, SubscriptionStatus> = {
  subscription_cancel: 'cancelled',
  subscription_suspend: 'suspended',
  subscription_activate: 'active',
};

/** Failure code of an uncertain lifecycle command the provider lookup shows did not take effect. */
export const SUBSCRIPTION_COMMAND_NOT_APPLIED = 'SUBSCRIPTION_COMMAND_NOT_APPLIED';

function isSubscriptionCommandKind(kind: PaymentOperationKind): kind is SubscriptionCommandKind {
  return kind in SUBSCRIPTION_COMMAND_TARGET;
}

/** Plan mismatches found by provider lookups are remembered per foreign plan, not per row. */
function lookupPlanMismatchKey(snapshot: ExecuteGetSubscriptionResult): string {
  return `lookup:${snapshot.providerPlanId ?? ''}`;
}

type SubscriptionLookup =
  | { kind: 'found'; snapshot: ExecuteGetSubscriptionResult }
  | { kind: 'unavailable' };

function mapMarketplaceStatusToOperationStatus(
  marketplaceStatus: MarketplaceOrderStatus,
  kind: PaymentOperation['kind'],
): PaymentOperationStatus | null {
  switch (marketplaceStatus) {
    case 'captured':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'approved':
    case 'created':
      return kind === 'marketplace_checkout' ? 'submitted' : 'unknown';
    case 'partially_captured':
      return 'unknown';
    case 'unknown':
    default:
      return 'unknown';
  }
}

function mapOrderLookupToStatus(
  operation: PaymentOperation,
  checkoutStatus: string,
): PaymentOperationStatus | null {
  if (operation.kind === 'checkout') {
    switch (checkoutStatus) {
      case 'approved':
      case 'created':
        return 'submitted';
      case 'captured':
        return 'succeeded';
      case 'voided':
      case 'failed':
        return 'failed';
      default:
        return null;
    }
  }
  if (operation.kind === 'capture') {
    switch (checkoutStatus) {
      case 'captured':
        return 'succeeded';
      case 'failed':
      case 'voided':
        return 'failed';
      default:
        return null;
    }
  }
  return null;
}

function mapRefundLookupToStatus(refundStatus: string): PaymentOperationStatus | null {
  switch (refundStatus) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'submitted';
    default:
      return null;
  }
}

/**
 * A `SubscriptionStore` is enough. Seller connections are reconciled only when the store has the
 * seller capability; payout and marketplace operations only with those capabilities. A capability
 * with only some of its methods throws `PaymentConfigurationError`.
 */
export type ReconciliationServiceStore = SubscriptionStore &
  Partial<PayoutStore & SellerStore & MarketplaceStore>;

const CAPABILITY_NOT_CONFIGURED = 'STORE_CAPABILITY_NOT_CONFIGURED';

/**
 * Rows that correlate to no operation cost one store lookup each: they are deferred without using
 * the `limit` budget, and one run scans at most `limit` times this many evidence rows.
 */
const UNMATCHED_SCAN_FACTOR = 10;

/**
 * Backoff (`retryBaseDelayMs`, `retryMaxDelayMs`, `maxAttempts`, see `RetryBackoffOptions`): a
 * candidate that is still unresolved after its attempt is deferred and gives up after
 * `maxAttempts` (issue #8). `submittedStaleAfterMs` (integer ms > 0, default
 * `DEFAULT_SUBMITTED_STALE_AFTER_MS`): a `submitted` operation without a provider reference this
 * long after its last write is treated as uncertain (issue #12).
 */
export type ReconciliationServiceOptions = RetryBackoffOptions & {
  submittedStaleAfterMs?: number;
};

export class ReconciliationService {
  private readonly retryPolicy: RetryBackoffPolicy;
  private readonly submittedStaleAfterMs: number;

  constructor(
    private readonly store: ReconciliationServiceStore,
    private readonly providerLookup: ReconciliationProviderLookup,
    /** Optional host hooks; `onSubscriptionEffects` gets the reducer's effects after each save. */
    private readonly hooks: SubscriptionEffectsHooks = {},
    options: ReconciliationServiceOptions = {},
  ) {
    this.retryPolicy = resolveRetryBackoffPolicy(options, 'Reconciliation');
    this.submittedStaleAfterMs = resolvePositiveDurationMs(
      options.submittedStaleAfterMs,
      'submittedStaleAfterMs',
      'Reconciliation',
      DEFAULT_SUBMITTED_STALE_AFTER_MS,
    );
    assertStoreCapabilitiesComplete(store, ['payout', 'seller', 'marketplace']);
  }

  /**
   * One run: due evidence candidates (at most `limit` that correlate to an operation; rows that
   * correlate to none are deferred and the batch is refilled), then due uncertain operations, then
   * seller connections. Every candidate still unresolved afterwards is deferred with backoff.
   */
  async reconcile(limit = 25): Promise<ReconcilePaymentOperationsResult> {
    const uncertainOperations = await this.store.listUncertainOperations(limit, {
      submittedStaleBefore: new Date(Date.now() - this.submittedStaleAfterMs).toISOString(),
      submittedStaleKinds: [...DEFAULT_SUBMITTED_STALE_KINDS],
    });
    const sellerStore = hasSellerStore(this.store) ? this.store : null;
    const connectionCandidates = sellerStore
      ? await sellerStore.listSellerConnectionsForReconciliation(limit)
      : [];
    const result: ReconcileCounters = {
      examined: uncertainOperations.length + connectionCandidates.length,
      applied: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      noOps: 0,
    };

    const reconciledOperationIds = await this.reconcileEvidenceCandidates(limit, result);

    for (const operation of uncertainOperations) {
      if (reconciledOperationIds.has(operation.operationId)) {
        continue;
      }
      await this.reconcileOperation(operation, result);
      await this.deferOperationIfUnresolved(operation.operationId);
    }

    if (sellerStore) {
      for (const connection of connectionCandidates) {
        const connectionResult = await reconcileSellerConnectionAggregate({
          store: sellerStore,
          providerLookup: this.providerLookup,
          connection,
        });
        if (connectionResult.outcome === 'applied') {
          result.applied += 1;
        } else if (connectionResult.outcome === 'retryable_failure') {
          result.retryableFailures += 1;
        } else {
          result.noOps += 1;
        }
      }
    }
    return result;
  }

  /** Returns the ids of the operations the examined evidence belongs to. */
  private async reconcileEvidenceCandidates(
    limit: number,
    result: ReconcileCounters,
  ): Promise<Set<string>> {
    const examined = new Set<string>();
    const relatedOperationIds = new Set<string>();
    const settledOperationIds = new Set<string>();
    const maxScanned = limit * UNMATCHED_SCAN_FACTOR;
    let correlated = 0;
    while (correlated < limit && examined.size < maxScanned) {
      // Deferred rows leave the due set, so the next page holds the rows behind them. A store that
      // ignores `nextAttemptAt` returns the same rows again: the run then stops.
      const page = (await this.store.listReconciliationCandidates(limit)).filter(
        (row) => !examined.has(row.evidenceId),
      );
      if (page.length === 0) {
        break;
      }
      for (const evidence of page) {
        if (correlated >= limit || examined.size >= maxScanned) {
          break;
        }
        examined.add(evidence.evidenceId);
        result.examined += 1;
        if (evidence.relatedOperationId) {
          relatedOperationIds.add(evidence.relatedOperationId);
        }
        if (await this.reconcileEvidence(evidence, result)) {
          correlated += 1;
        }
        await this.deferEvidenceIfStillCandidate(evidence.evidenceId);
        // The operation phase skips this operation: it waits (or is cleared) here, once per run.
        if (evidence.relatedOperationId && !settledOperationIds.has(evidence.relatedOperationId)) {
          settledOperationIds.add(evidence.relatedOperationId);
          await this.deferOperationIfUnresolved(evidence.relatedOperationId);
        }
      }
    }
    return relatedOperationIds;
  }

  /**
   * Still `unmatched`, or its operation still `unknown`: wait for the backoff (issue #8). A row
   * that resolved (no longer `pending`/`unmatched`, operation no longer `unknown`) keeps no retry
   * state.
   */
  private async deferEvidenceIfStillCandidate(evidenceId: string): Promise<void> {
    const fresh = await this.store.findEvidenceById(evidenceId);
    if (!fresh || fresh.verificationStatus !== 'verified') {
      return;
    }
    const related = fresh.relatedOperationId
      ? await this.store.findOperationById(fresh.relatedOperationId)
      : null;
    if (fresh.processingStatus !== 'unmatched' && related?.status !== 'unknown') {
      if (fresh.processingStatus !== 'pending' && hasRetryState(fresh)) {
        await this.store.updateEvidence({ evidenceId, ...CLEARED_RETRY_STATE });
      }
      return;
    }
    await this.store.updateEvidence({
      evidenceId,
      ...nextRetryDeferral(fresh.attempts, this.retryPolicy),
    });
  }

  /** Still `unknown` (or a `submitted` create without provider reference): wait for the backoff. */
  private async deferOperationIfUnresolved(operationId: string): Promise<void> {
    const fresh = await this.store.findOperationById(operationId);
    if (!fresh) {
      return;
    }
    if (
      fresh.status !== 'unknown' &&
      !(fresh.status === 'submitted' && !fresh.providerReferenceId)
    ) {
      await clearResolvedOperationRetryState(this.store, fresh);
      return;
    }
    try {
      await this.store.updateOperation({
        operationId,
        expectedVersion: fresh.version,
        ...nextRetryDeferral(fresh.attempts, this.retryPolicy),
      });
    } catch (error) {
      // Another writer moved the operation on; it is listed again by its new state.
      if (
        !(error instanceof PaymentReliabilityError) ||
        error.code !== PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT
      ) {
        throw error;
      }
    }
  }

  /** `false` when no operation correlates (the row is foreign or not matchable yet). */
  private async reconcileEvidence(
    evidence: ProviderEvidenceRecord,
    result: ReconcileCounters,
  ): Promise<boolean> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const mappedFromEvent = evidence.eventType
      ? mapCheckoutWebhookEventToStatus(evidence.eventType)
      : null;
    const mappedPayoutFromEvent = evidence.eventType
      ? mapPayoutWebhookEventToFinancialStatus(evidence.eventType)
      : null;
    const mappedPlanFromEvent = evidence.eventType
      ? mapPlanWebhookEventToStatus(evidence.eventType)
      : null;

    let operation =
      evidence.relatedOperationId &&
      (await this.store.findOperationById(evidence.relatedOperationId));

    if (!operation) {
      operation = await this.findOperationForEvidence(evidence);
    }

    if (!operation) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        outcome: 'no_op',
        resultCode: 'UNMATCHED',
        resultMessage: 'No operation correlated during reconciliation',
      });
      result.noOps += 1;
      return false;
    }

    if (operation.kind === 'subscription') {
      await this.reconcileSubscriptionEvidence(evidence, operation, result);
      return true;
    }
    if (isSubscriptionCommandKind(operation.kind)) {
      await this.reconcileSubscriptionCommand(operation, result);
      return true;
    }

    const providerOutcome = await this.lookupProviderOutcome(operation, evidence.resourceId);
    const outcome: ReconciliationOutcome = {
      executionStatus:
        mappedFromEvent ??
        (mappedPayoutFromEvent
          ? payoutFinancialStatusToOperationStatus(mappedPayoutFromEvent)
          : mappedPlanFromEvent
            ? planStatusToOperationStatus(mappedPlanFromEvent)
            : providerOutcome.executionStatus),
      payoutStatus: mappedPayoutFromEvent ?? providerOutcome.payoutStatus,
      planStatus: mappedPlanFromEvent ?? providerOutcome.planStatus,
    };

    await this.applyReconciliationOutcome({
      evidenceId: evidence.evidenceId,
      eventType: evidence.eventType,
      rawPayload: evidence.rawPayload,
      operation,
      outcome,
      result,
      providerReferenceId: evidence.resourceId ?? operation.providerReferenceId,
    });
    return true;
  }

  private async reconcileOperation(
    listed: PaymentOperation,
    result: ReconcileCounters,
  ): Promise<void> {
    let operation = listed;
    if (isSubscriptionCommandKind(operation.kind)) {
      await this.reconcileSubscriptionCommand(operation, result);
      return;
    }
    const providerReferenceId = this.resolveProviderReferenceId(operation);

    if (!providerReferenceId) {
      if (operation.status === 'submitted') {
        const marked = await this.markStaleSubmittedUnknown(operation);
        if (!marked) {
          return;
        }
        operation = marked;
      }
      const evidence = await this.insertReconciliationEvidence(operation, {
        resourceId: null,
        eventType: 'RECONCILIATION.MISSING_PROVIDER_REFERENCE',
      });
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'no_op',
        resultCode: 'MISSING_PROVIDER_REFERENCE',
        resultMessage: 'Provider lookup cannot run without a stored provider id',
      });
      result.noOps += 1;
      return;
    }

    if (operation.kind === 'subscription') {
      const lookup = await this.lookupSubscription(operation, providerReferenceId);
      const evidence = await this.insertReconciliationEvidence(operation, {
        resourceId: providerReferenceId,
        eventType: 'RECONCILIATION.PROVIDER_LOOKUP',
      });
      await this.applySubscriptionReconciliation({
        evidence,
        operation,
        steps:
          lookup.kind === 'found' ? [this.lookupStep(providerReferenceId, lookup.snapshot)] : [],
        result,
        planMismatchKey:
          lookup.kind === 'found' ? lookupPlanMismatchKey(lookup.snapshot) : undefined,
      });
      return;
    }

    const outcome = await this.lookupProviderOutcome(operation, providerReferenceId);
    const evidence = await this.insertReconciliationEvidence(operation, {
      resourceId: providerReferenceId,
      eventType: 'RECONCILIATION.PROVIDER_LOOKUP',
    });

    await this.applyReconciliationOutcome({
      evidenceId: evidence.evidenceId,
      operation,
      outcome,
      result,
      providerReferenceId,
    });
  }

  /**
   * A `submitted` create without any provider id long after its claim: the worker died before it
   * wrote the provider result (issue #12). Mark it `unknown` so the host's create retry (same
   * provider request id) and the uncertain views pick it up. `null` when another writer moved it.
   */
  private async markStaleSubmittedUnknown(
    operation: PaymentOperation,
  ): Promise<PaymentOperation | null> {
    try {
      return await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'unknown',
        ...(operation.kind === 'subscription' ? { subscriptionStatus: 'unknown' as const } : {}),
        failureCode: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        failureMessage: 'The provider call did not record a result',
        reason: 'Reconciliation found a stale submitted operation without provider reference',
      });
    } catch (error) {
      if (
        error instanceof PaymentReliabilityError &&
        error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT
      ) {
        return null;
      }
      throw error;
    }
  }

  private resolveProviderReferenceId(operation: PaymentOperation): string | null {
    if (operation.kind === 'refund') {
      return (
        operation.providerRefundId ?? operation.providerReferenceId ?? operation.providerCaptureId
      );
    }
    if (operation.kind === 'payout_batch') {
      return operation.providerPayoutBatchId ?? operation.providerReferenceId;
    }
    if (operation.kind === 'payout_item') {
      return operation.providerPayoutItemId ?? operation.providerReferenceId;
    }
    if (operation.kind === 'catalog_product') {
      return operation.providerProductId ?? operation.providerReferenceId;
    }
    if (operation.kind === 'billing_plan' || operation.kind === 'plan_lifecycle') {
      return operation.providerPlanId ?? operation.providerReferenceId;
    }
    if (
      operation.kind === 'subscription' ||
      operation.kind === 'subscription_cancel' ||
      operation.kind === 'subscription_suspend' ||
      operation.kind === 'subscription_activate'
    ) {
      return operation.providerSubscriptionId ?? operation.providerReferenceId;
    }
    if (operation.kind === 'seller_referral') {
      return operation.providerReferralId ?? operation.providerReferenceId;
    }
    return (
      operation.providerOrderId ?? operation.providerCaptureId ?? operation.providerReferenceId
    );
  }

  private async findOperationForEvidence(evidence: ProviderEvidenceRecord) {
    const payoutKind = evidence.eventType
      ? mapPayoutWebhookEventToFinancialStatus(evidence.eventType)
      : null;
    if (payoutKind) {
      if (!hasPayoutStore(this.store)) {
        return null;
      }
      const correlation = await correlatePayoutOperation(this.store, {
        providerCode: evidence.providerCode,
        accountRef: evidence.accountRef,
        applicationRef: evidence.applicationRef,
        environment: evidence.environment,
        eventType: evidence.eventType,
        resourceId: evidence.resourceId,
        rawPayload: evidence.rawPayload,
      });
      return correlation?.operation ?? null;
    }

    if (evidence.eventType && isSubscriptionEvidenceEvent(evidence.eventType)) {
      // Sales carry the subscription id in `billing_agreement_id`, never in `resource.id`.
      const event = normalizeSubscriptionEvidencePayload(
        evidence.rawPayload,
        evidence.providerEventId,
      );
      return event
        ? this.store.findOperationByProviderSubscriptionId(
            evidence.providerCode,
            evidence.accountRef,
            evidence.environment,
            event.providerSubscriptionId,
          )
        : null;
    }

    const resourceId = evidence.resourceId;
    if (!resourceId) {
      return null;
    }

    const planStatus = evidence.eventType ? mapPlanWebhookEventToStatus(evidence.eventType) : null;
    if (planStatus) {
      return this.store.findOperationByProviderPlanId(
        evidence.providerCode,
        evidence.accountRef,
        evidence.environment,
        resourceId,
      );
    }

    if (evidence.eventType && isSellerOnboardingWebhookEvent(evidence.eventType)) {
      if (!hasSellerStore(this.store)) {
        return null;
      }
      return this.store.findOperationByProviderReferralId(
        evidence.providerCode,
        evidence.accountRef,
        evidence.environment,
        resourceId,
      );
    }

    return this.store.findOperationByProviderReference(
      evidence.providerCode,
      evidence.accountRef,
      evidence.environment,
      resourceId,
    );
  }

  private async lookupProviderOutcome(
    operation: PaymentOperation,
    providerReferenceId: string | null | undefined,
  ): Promise<ReconciliationOutcome> {
    if (!providerReferenceId) {
      return { executionStatus: null, payoutStatus: null };
    }

    const context = {
      providerCode: operation.providerCode,
      accountRef: operation.accountRef,
      applicationRef: operation.applicationRef,
      environment: operation.environment,
    };

    try {
      if (operation.kind === 'refund') {
        const refundId = operation.providerRefundId ?? providerReferenceId;
        const lookup = await this.providerLookup.getRefund({
          ...context,
          providerRefundId: refundId,
        });
        return {
          executionStatus: mapRefundLookupToStatus(lookup.refundStatus),
          payoutStatus: null,
        };
      }

      if (operation.kind === 'payout_batch') {
        const batchId = operation.providerPayoutBatchId ?? providerReferenceId;
        const lookup = await this.providerLookup.getPayoutBatch({
          ...context,
          providerPayoutBatchId: batchId,
        });
        return {
          executionStatus: payoutFinancialStatusToOperationStatus(lookup.batchPayoutStatus),
          payoutStatus: lookup.batchPayoutStatus,
        };
      }

      if (operation.kind === 'payout_item') {
        const itemId = operation.providerPayoutItemId ?? providerReferenceId;
        const lookup = await this.providerLookup.getPayoutItem({
          ...context,
          providerPayoutItemId: itemId,
        });
        return {
          executionStatus: payoutFinancialStatusToOperationStatus(lookup.payoutStatus),
          payoutStatus: lookup.payoutStatus,
          providerTransactionId: lookup.providerTransactionId,
          providerFeeMinor: lookup.providerFee?.amountMinor ?? null,
          providerFeeCurrency: lookup.providerFee?.currency ?? null,
          failureCode: lookup.failureCode,
          failureMessage: lookup.failureMessage,
        };
      }

      if (operation.kind === 'catalog_product') {
        const productId = operation.providerProductId ?? providerReferenceId;
        const lookup = await this.providerLookup.getProduct({
          ...context,
          providerProductId: productId,
        });
        return {
          executionStatus: lookup.productStatus === 'created' ? 'succeeded' : 'submitted',
          payoutStatus: null,
        };
      }

      if (operation.kind === 'billing_plan' || operation.kind === 'plan_lifecycle') {
        const planId = operation.providerPlanId ?? providerReferenceId;
        const lookup = await this.providerLookup.getPlan({
          ...context,
          providerPlanId: planId,
        });
        return {
          executionStatus: planStatusToOperationStatus(lookup.planStatus),
          payoutStatus: null,
          planStatus: lookup.planStatus,
        };
      }

      if (operation.kind === 'seller_referral') {
        const referralId = operation.providerReferralId ?? providerReferenceId;
        const lookup = await this.providerLookup.getReferral({
          ...context,
          providerReferralId: referralId,
        });
        return {
          executionStatus: lookup.providerReferralId ? 'succeeded' : 'unknown',
          payoutStatus: null,
          referralActionUrl: lookup.actionUrl,
          referralProviderReferralId: lookup.providerReferralId,
        };
      }

      if (operation.kind === 'marketplace_checkout' || operation.kind === 'marketplace_capture') {
        let checkoutOperation = operation;
        if (operation.kind === 'marketplace_capture' && operation.parentOperationId) {
          const parent = await this.store.findOperationById(operation.parentOperationId);
          if (parent?.kind === 'marketplace_checkout') {
            checkoutOperation = parent;
          }
        }
        const orderId = checkoutOperation.providerOrderId ?? providerReferenceId;
        if (!orderId) {
          return { executionStatus: null, payoutStatus: null };
        }
        const lookup = await this.providerLookup.getMarketplaceOrder({
          ...context,
          providerOrderId: orderId,
        });
        return {
          executionStatus: mapMarketplaceStatusToOperationStatus(
            lookup.marketplaceStatus,
            operation.kind,
          ),
          payoutStatus: null,
          marketplaceUnits: lookup.units,
          marketplaceCheckoutOperationId: checkoutOperation.operationId,
        };
      }

      const orderId = operation.providerOrderId ?? providerReferenceId;
      const lookup = await this.providerLookup.getOrder({
        ...context,
        providerOrderId: orderId,
      });
      return {
        executionStatus: mapOrderLookupToStatus(operation, lookup.checkoutStatus),
        payoutStatus: null,
      };
    } catch (error) {
      const err = error as { code?: string; retryable?: boolean; uncertain?: boolean };
      if (err?.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND) {
        return { executionStatus: 'failed', payoutStatus: null };
      }
      if (err?.retryable || err?.uncertain) {
        return { executionStatus: 'unknown', payoutStatus: 'unknown' };
      }
      return { executionStatus: null, payoutStatus: null };
    }
  }

  private async applyReconciliationOutcome(input: {
    evidenceId: string;
    eventType?: string | null;
    rawPayload?: string;
    operation: PaymentOperation;
    outcome: ReconciliationOutcome;
    result: ReconcileCounters;
    providerReferenceId: string | null;
  }): Promise<void> {
    const { evidenceId, eventType, rawPayload, operation, outcome, result, providerReferenceId } =
      input;

    if (operation.kind === 'payout_batch' || operation.kind === 'payout_item') {
      if (!hasPayoutStore(this.store)) {
        await this.recordCapabilityNotConfigured(evidenceId, operation.operationId, result);
        return;
      }
      await this.applyPayoutReconciliationOutcome(this.store, {
        evidenceId,
        eventType: eventType ?? null,
        rawPayload: rawPayload ?? '',
        operation,
        outcome,
        result,
        providerReferenceId,
      });
      return;
    }

    if (operation.kind === 'billing_plan' || operation.kind === 'plan_lifecycle') {
      await this.applyPlanReconciliationOutcome({
        evidenceId,
        operation,
        outcome,
        result,
        providerReferenceId,
      });
      return;
    }

    if (operation.kind === 'seller_referral') {
      await this.applySellerReferralReconciliationOutcome({
        evidenceId,
        operation,
        outcome,
        result,
        providerReferenceId,
      });
      return;
    }

    if (operation.kind === 'marketplace_checkout' || operation.kind === 'marketplace_capture') {
      if (!hasMarketplaceStore(this.store)) {
        await this.recordCapabilityNotConfigured(evidenceId, operation.operationId, result);
        return;
      }
      await this.applyMarketplaceReconciliationOutcome(this.store, {
        evidenceId,
        operation,
        outcome,
        result,
        providerReferenceId,
      });
      return;
    }

    const nextStatus = outcome.executionStatus;
    if (!nextStatus || nextStatus === 'unknown') {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    try {
      assertTransitionAllowed(operation.status, nextStatus);
      await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus,
        providerReferenceId: providerReferenceId ?? operation.providerReferenceId,
        evidenceId,
        reason: 'Reconciliation applied allowed transition',
      });
      await this.store.updateEvidence({
        evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  /**
   * Webhook evidence of a subscription: a payment event is reduced first (it records the payment),
   * then the provider lookup as the current truth. Without a usable lookup a status event is
   * reduced on its own, ordered by its resource time.
   */
  private async reconcileSubscriptionEvidence(
    evidence: ProviderEvidenceRecord,
    operation: PaymentOperation,
    result: ReconcileCounters,
  ): Promise<void> {
    const event = normalizeSubscriptionEvidencePayload(
      evidence.rawPayload,
      evidence.providerEventId,
    );
    const steps: SubscriptionEventStep[] = [];
    const isPayment =
      event !== null &&
      (event.resourceType === 'sale' || isSubscriptionPaymentEvidenceEvent(event.eventType));
    if (event && isPayment) {
      steps.push({
        event,
        options: {
          source: 'webhook',
          expectedPayment:
            event.resourceType === 'sale'
              ? await resolveExpectedSubscriptionPayment(this.store, operation)
              : null,
        },
      });
    }

    // The subscription id comes from the operation, else from the event; never from a sale id.
    const providerSubscriptionId =
      operation.providerSubscriptionId ?? event?.providerSubscriptionId ?? null;
    const lookup = providerSubscriptionId
      ? await this.lookupSubscription(operation, providerSubscriptionId)
      : ({ kind: 'unavailable' } as const);
    if (lookup.kind === 'found' && providerSubscriptionId) {
      steps.push(this.lookupStep(providerSubscriptionId, lookup.snapshot));
    } else if (event && !isPayment) {
      steps.push({ event, options: { source: 'webhook' } });
    }

    await this.applySubscriptionReconciliation({ evidence, operation, steps, result });
  }

  private lookupStep(
    providerSubscriptionId: string,
    snapshot: ExecuteGetSubscriptionResult,
  ): SubscriptionEventStep {
    return {
      event: subscriptionEventFromProviderSnapshot(providerSubscriptionId, snapshot),
      options: { source: 'lookup' },
    };
  }

  /** A provider GET with a recognised status, or `unavailable` (failure, not found, unknown status). */
  private async lookupSubscription(
    operation: PaymentOperation,
    providerSubscriptionId: string,
  ): Promise<SubscriptionLookup> {
    try {
      const snapshot = await this.providerLookup.getSubscription({
        providerCode: operation.providerCode,
        accountRef: operation.accountRef,
        applicationRef: operation.applicationRef,
        environment: operation.environment,
        providerSubscriptionId,
      });
      return snapshot.subscriptionStatus && snapshot.subscriptionStatus !== 'unknown'
        ? { kind: 'found', snapshot }
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private async applySubscriptionReconciliation(input: {
    evidence: ProviderEvidenceRecord;
    operation: PaymentOperation;
    steps: SubscriptionEventStep[];
    result: ReconcileCounters;
    /** A lookup-only run gets a new evidence row each time: remember its mismatch by plan. */
    planMismatchKey?: string | null;
  }): Promise<void> {
    const { evidence, operation, steps, result } = input;
    if (steps.length === 0) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Subscription provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    let applied: ApplySubscriptionEventsResult;
    try {
      applied = await applySubscriptionEvents(this.store, {
        operation,
        steps,
        evidenceId: evidence.evidenceId,
        planMismatchKey: input.planMismatchKey,
        reason: 'Reconciliation applied subscription transition',
        holdEffects: Boolean(this.hooks.onSubscriptionEffects),
      });
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
      return;
    }
    const delivered = await this.deliverSubscriptionEffects(evidence, applied);

    if (applied.heldOverflow) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: HELD_EFFECTS_OVERFLOW,
        resultMessage: 'Not applied: the subscription holds the maximum of undelivered effects',
      });
      result.retryableFailures += 1;
      return;
    }
    if (applied.equalTimestampConflict) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP,
        resultMessage: 'Status conflicts at the same provider state time; a lookup must settle it',
      });
      result.retryableFailures += 1;
      return;
    }
    if (applied.planMismatch) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'terminal_failure',
        resultCode: PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
        resultMessage: 'Provider subscription plan does not match the stored plan',
      });
      result.terminalFailures += 1;
      return;
    }
    if (delivered) {
      await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
    }
    await this.store.insertReconciliationAttempt({
      evidenceId: evidence.evidenceId,
      operationId: operation.operationId,
      outcome: 'applied',
      resultCode: 'APPLIED',
    });
    result.applied += 1;
  }

  /**
   * Hand the effects to the host hook. When it throws (or the effects cannot be held), the evidence
   * row is left `pending` with the delivery code: held effects stay on the subscription operation
   * and `PaymentRecoveryService` delivers them through the webhook service's hook.
   */
  private async deliverSubscriptionEffects(
    evidence: ProviderEvidenceRecord,
    applied: ApplySubscriptionEventsResult,
  ): Promise<boolean> {
    const delivery = await deliverSubscriptionEffects(this.store, this.hooks, applied, {
      evidenceId: evidence.evidenceId,
      eventType: evidence.eventType ?? 'RECONCILIATION.PROVIDER_LOOKUP',
      source: 'reconciliation',
    });
    if (delivery.delivered) {
      return true;
    }
    await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: applied.operation.operationId,
      processingStatus: 'pending',
      errorCode: delivery.code,
      errorMessage:
        delivery.code === SUBSCRIPTION_EFFECTS_HOOK_FAILED
          ? 'Subscription effects hook failed; the effects are delivered again on retry'
          : 'Subscription effects were not delivered; the row is processed again on retry',
      processedAt: null,
    });
    return false;
  }

  /**
   * An uncertain cancel/suspend/activate command. The provider lookup is applied to the parent
   * subscription operation (which holds the provider ids); the command itself only ends
   * `succeeded` (the subscription reached the command's target status) or `failed`
   * (`SUBSCRIPTION_COMMAND_NOT_APPLIED`). No provider id is ever written onto the command.
   */
  private async reconcileSubscriptionCommand(
    operation: PaymentOperation,
    result: ReconcileCounters,
  ): Promise<void> {
    const parentCandidate = operation.parentOperationId
      ? await this.store.findOperationById(operation.parentOperationId)
      : null;
    const parent = parentCandidate?.kind === 'subscription' ? parentCandidate : null;
    const providerSubscriptionId =
      parent?.providerSubscriptionId ?? operation.providerSubscriptionId ?? null;

    const evidence = await this.insertReconciliationEvidence(operation, {
      resourceId: providerSubscriptionId,
      eventType: providerSubscriptionId
        ? 'RECONCILIATION.PROVIDER_LOOKUP'
        : 'RECONCILIATION.MISSING_PROVIDER_REFERENCE',
    });
    if (!providerSubscriptionId) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'no_op',
        resultCode: 'MISSING_PROVIDER_REFERENCE',
        resultMessage: 'Provider lookup cannot run without a stored provider id',
      });
      result.noOps += 1;
      return;
    }

    const lookup = await this.lookupSubscription(operation, providerSubscriptionId);
    if (lookup.kind !== 'found' || !isSubscriptionCommandKind(operation.kind)) {
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Subscription provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    try {
      let delivered = true;
      if (parent) {
        const applied = await applySubscriptionEvents(this.store, {
          operation: parent,
          steps: [this.lookupStep(providerSubscriptionId, lookup.snapshot)],
          evidenceId: evidence.evidenceId,
          planMismatchKey: lookupPlanMismatchKey(lookup.snapshot),
          reason: 'Reconciliation applied subscription transition',
          holdEffects: Boolean(this.hooks.onSubscriptionEffects),
        });
        delivered = await this.deliverSubscriptionEffects(evidence, applied);
      }

      const providerStatus = lookup.snapshot.subscriptionStatus;
      const reached = providerStatus === SUBSCRIPTION_COMMAND_TARGET[operation.kind];
      assertTransitionAllowed(operation.status, reached ? 'succeeded' : 'failed');
      await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: reached ? 'succeeded' : 'failed',
        failureCode: reached ? null : SUBSCRIPTION_COMMAND_NOT_APPLIED,
        failureMessage: reached
          ? null
          : `Provider subscription status is ${providerStatus} after the uncertain command`,
        evidenceId: evidence.evidenceId,
        reason: 'Reconciliation resolved subscription command',
      });
      if (delivered) {
        await this.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          processingStatus: 'processed',
          processedAt: new Date().toISOString(),
        });
      }
      await this.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId: evidence.evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  private async applyPlanReconciliationOutcome(input: {
    evidenceId: string;
    operation: PaymentOperation;
    outcome: ReconciliationOutcome;
    result: ReconcileCounters;
    providerReferenceId: string | null;
  }): Promise<void> {
    const { evidenceId, operation, outcome, result, providerReferenceId } = input;
    const planStatus = outcome.planStatus;
    if (!planStatus || planStatus === 'unknown') {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Plan provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    try {
      await applyPlanTransition(this.store, {
        operation,
        planStatus,
        evidenceId,
        reason: 'Reconciliation applied plan transition',
        providerReferenceId,
        providerPlanId: providerReferenceId ?? undefined,
      });
      await this.store.updateEvidence({
        evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  private async applySellerReferralReconciliationOutcome(input: {
    evidenceId: string;
    operation: PaymentOperation;
    outcome: ReconciliationOutcome;
    result: ReconcileCounters;
    providerReferenceId: string | null;
  }): Promise<void> {
    const { evidenceId, outcome, result, providerReferenceId } = input;
    let operation = input.operation;
    const nextStatus = outcome.executionStatus;

    if (!nextStatus || nextStatus === 'unknown') {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Seller referral provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    try {
      if (
        outcome.referralActionUrl !== undefined ||
        outcome.referralProviderReferralId !== undefined
      ) {
        operation = await this.store.updateOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          approvalUrl: outcome.referralActionUrl ?? operation.approvalUrl,
          providerReferralId: outcome.referralProviderReferralId ?? operation.providerReferralId,
          providerReferenceId:
            outcome.referralProviderReferralId ??
            providerReferenceId ??
            operation.providerReferenceId,
        });
      }
      assertTransitionAllowed(operation.status, nextStatus);
      await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus,
        providerReferralId: operation.providerReferralId,
        providerReferenceId: providerReferenceId ?? operation.providerReferenceId,
        approvalUrl: operation.approvalUrl,
        evidenceId,
        reason: 'Reconciliation refreshed seller referral metadata',
      });
      await this.store.updateEvidence({
        evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  private async applyMarketplaceReconciliationOutcome(
    store: ReconciliationServiceStore & MarketplaceStore,
    input: {
      evidenceId: string;
      operation: PaymentOperation;
      outcome: ReconciliationOutcome;
      result: ReconcileCounters;
      providerReferenceId: string | null;
    },
  ): Promise<void> {
    const { evidenceId, operation, outcome, result, providerReferenceId } = input;
    const checkoutOperationId =
      outcome.marketplaceCheckoutOperationId ??
      (operation.kind === 'marketplace_checkout'
        ? operation.operationId
        : operation.parentOperationId);

    if (!checkoutOperationId || !outcome.marketplaceUnits?.length) {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Marketplace provider lookup returned no purchase units',
      });
      result.retryableFailures += 1;
      return;
    }

    const nextStatus = outcome.executionStatus;
    if (!nextStatus) {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Marketplace provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    try {
      await applyMarketplaceUnitSnapshots({
        store,
        operationId: checkoutOperationId,
        snapshots: outcome.marketplaceUnits,
        preserveCaptured: true,
      });
      if (nextStatus !== operation.status) {
        assertTransitionAllowed(operation.status, nextStatus);
        await this.store.transitionOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          nextStatus,
          providerReferenceId: providerReferenceId ?? operation.providerReferenceId,
          evidenceId,
          reason: 'Reconciliation applied marketplace transition',
        });
      }
      await this.store.updateEvidence({
        evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  private async applyPayoutReconciliationOutcome(
    store: ReconciliationServiceStore & PayoutStore,
    input: {
      evidenceId: string;
      eventType: string | null;
      rawPayload: string;
      operation: PaymentOperation;
      outcome: ReconciliationOutcome;
      result: ReconcileCounters;
      providerReferenceId: string | null;
    },
  ): Promise<void> {
    const { evidenceId, eventType, rawPayload, operation, outcome, result, providerReferenceId } =
      input;
    const payoutStatus = outcome.payoutStatus;

    if (!payoutStatus || payoutStatus === 'unknown') {
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'retryable_failure',
        resultCode: 'UNKNOWN_OUTCOME',
        resultMessage: 'Payout provider state remains unknown',
      });
      result.retryableFailures += 1;
      return;
    }

    const parsed = parsePaypalPayoutWebhookPayload(rawPayload, eventType);
    const providerFields = parsed
      ? buildPayoutTransitionProviderFields(operation, parsed, payoutStatus)
      : {
          providerReferenceId,
          providerPayoutBatchId:
            operation.kind === 'payout_batch' ? (providerReferenceId ?? undefined) : undefined,
          providerPayoutItemId:
            operation.kind === 'payout_item' ? (providerReferenceId ?? undefined) : undefined,
          failureCode: null,
          failureMessage: null,
        };

    try {
      await applyPayoutTransition(store, {
        operation,
        payoutStatus,
        evidenceId,
        reason: 'Reconciliation applied payout transition',
        providerReferenceId: providerFields.providerReferenceId ?? providerReferenceId,
        providerPayoutBatchId: providerFields.providerPayoutBatchId,
        providerPayoutItemId: providerFields.providerPayoutItemId,
        providerTransactionId:
          outcome.providerTransactionId ?? providerFields.providerTransactionId ?? undefined,
        providerFeeMinor: outcome.providerFeeMinor ?? providerFields.providerFeeMinor ?? undefined,
        providerFeeCurrency:
          outcome.providerFeeCurrency ?? providerFields.providerFeeCurrency ?? undefined,
        failureCode: outcome.failureCode ?? providerFields.failureCode ?? undefined,
        failureMessage: outcome.failureMessage ?? providerFields.failureMessage ?? undefined,
      });

      if (operation.kind === 'payout_item' && operation.parentOperationId) {
        const batch = await this.store.findOperationById(operation.parentOperationId);
        if (batch) {
          await refreshPayoutBatchAggregate(
            store,
            batch,
            evidenceId,
            'Derived payout batch aggregate after reconciliation',
          );
        }
      }

      await this.store.updateEvidence({
        evidenceId,
        relatedOperationId: operation.operationId,
        resourceId: parsed?.canonicalResourceId ?? providerReferenceId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      await this.store.insertReconciliationAttempt({
        evidenceId,
        operationId: operation.operationId,
        outcome: 'applied',
        resultCode: 'APPLIED',
      });
      result.applied += 1;
    } catch (error) {
      await this.recordReconciliationFailure({
        evidenceId,
        operationId: operation.operationId,
        result,
        error,
      });
    }
  }

  private async recordCapabilityNotConfigured(
    evidenceId: string,
    operationId: string,
    result: ReconcileCounters,
  ): Promise<void> {
    await this.store.insertReconciliationAttempt({
      evidenceId,
      operationId,
      outcome: 'no_op',
      resultCode: CAPABILITY_NOT_CONFIGURED,
      resultMessage: 'The store does not implement this operation family',
    });
    result.noOps += 1;
  }

  private async recordReconciliationFailure(input: {
    evidenceId: string;
    operationId: string;
    result: ReconcileCounters;
    error: unknown;
  }): Promise<void> {
    const rawMessage =
      input.error instanceof Error ? input.error.message : String(input.error);
    const message = sanitizeOperationalErrorMessage(
      input.error,
      'Reconciliation processing failed',
    );
    const terminal = rawMessage.includes('Terminal operation status');
    await this.store.insertReconciliationAttempt({
      evidenceId: input.evidenceId,
      operationId: input.operationId,
      outcome: terminal ? 'terminal_failure' : 'retryable_failure',
      resultCode: terminal ? 'TERMINAL' : 'RETRYABLE',
      resultMessage: message,
    });
    if (terminal) {
      input.result.terminalFailures += 1;
    } else {
      input.result.retryableFailures += 1;
    }
  }

  private async insertReconciliationEvidence(
    operation: PaymentOperation,
    input: { resourceId: string | null; eventType: string },
  ): Promise<ProviderEvidenceRecord> {
    const rawPayload = JSON.stringify({
      operationId: operation.operationId,
      kind: operation.kind,
      resourceId: input.resourceId,
      eventType: input.eventType,
    });
    const evidence = await this.store.insertEvidence({
      providerCode: operation.providerCode,
      accountRef: operation.accountRef,
      applicationRef: operation.applicationRef,
      environment: operation.environment,
      evidenceKind: 'reconciliation',
      providerEventId: `reconcile-${operation.operationId}-${Date.now()}`,
      rawPayload,
      payloadSha256: sha256Payload(rawPayload),
      eventType: input.eventType,
      resourceId: input.resourceId,
    });
    return this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      processingStatus: 'pending',
      relatedOperationId: operation.operationId,
    });
  }
}
