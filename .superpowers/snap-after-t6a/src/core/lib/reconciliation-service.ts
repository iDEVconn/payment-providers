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
import { PAYMENT_RELIABILITY_ERROR } from '../../contracts/index';
import { sanitizeOperationalErrorMessage } from './public-error-sanitizer';
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
  isSubscriptionWebhookProviderRefreshEvent,
  mapPlanWebhookEventToStatus,
  mapSubscriptionWebhookEventToStatus,
  planStatusToOperationStatus,
} from './subscription-transition-policy';
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

function isSubscriptionEvidenceEvent(eventType: string): boolean {
  return (
    mapSubscriptionWebhookEventToStatus(eventType) !== null ||
    isSubscriptionWebhookProviderRefreshEvent(eventType) ||
    isSubscriptionPaymentEvidenceEvent(eventType)
  );
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

export class ReconciliationService {
  constructor(
    private readonly store: ReconciliationServiceStore,
    private readonly providerLookup: ReconciliationProviderLookup,
    /** Optional host hooks; `onSubscriptionEffects` gets the reducer's effects after each save. */
    private readonly hooks: SubscriptionEffectsHooks = {},
  ) {
    assertStoreCapabilitiesComplete(store, ['payout', 'seller', 'marketplace']);
  }

  async reconcile(limit = 25): Promise<ReconcilePaymentOperationsResult> {
    const evidenceCandidates = await this.store.listReconciliationCandidates(limit);
    const uncertainOperations = await this.store.listUncertainOperations(limit);
    const sellerStore = hasSellerStore(this.store) ? this.store : null;
    const connectionCandidates = sellerStore
      ? await sellerStore.listSellerConnectionsForReconciliation(limit)
      : [];
    const result: ReconcileCounters = {
      examined:
        evidenceCandidates.length + uncertainOperations.length + connectionCandidates.length,
      applied: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      noOps: 0,
    };

    for (const evidence of evidenceCandidates) {
      await this.reconcileEvidence(evidence, result);
    }

    const reconciledOperationIds = new Set(
      evidenceCandidates
        .map((row) => row.relatedOperationId)
        .filter((operationId): operationId is string => Boolean(operationId)),
    );

    for (const operation of uncertainOperations) {
      if (reconciledOperationIds.has(operation.operationId)) {
        continue;
      }
      await this.reconcileOperation(operation, result);
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

  private async reconcileEvidence(
    evidence: ProviderEvidenceRecord,
    result: ReconcileCounters,
  ): Promise<void> {
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
      return;
    }

    if (operation.kind === 'subscription') {
      await this.reconcileSubscriptionEvidence(evidence, operation, result);
      return;
    }
    if (isSubscriptionCommandKind(operation.kind)) {
      await this.reconcileSubscriptionCommand(operation, result);
      return;
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
  }

  private async reconcileOperation(
    operation: PaymentOperation,
    result: ReconcileCounters,
  ): Promise<void> {
    if (isSubscriptionCommandKind(operation.kind)) {
      await this.reconcileSubscriptionCommand(operation, result);
      return;
    }
    const providerReferenceId = this.resolveProviderReferenceId(operation);

    if (!providerReferenceId) {
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
