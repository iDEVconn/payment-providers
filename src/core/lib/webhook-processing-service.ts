import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperationStatus,
  type ProviderEvidenceRecord,
  type SubscriptionStatus,
  type VerifyWebhookResult,
  type WebhookReceiptResponse,
} from '../../contracts/index';
import {
  assertTransitionAllowed,
  assertVerifiedEvidence,
  mapCheckoutWebhookEventToStatus,
  mapWebhookEventToOperationKind,
} from './transition-policy';
import { mapPayoutWebhookEventToFinancialStatus } from './payout-transition-policy';
import { applyPayoutTransition, refreshPayoutBatchAggregate } from './payout-evidence-application';
import {
  buildPayoutTransitionProviderFields,
  correlatePayoutOperation,
  parsePaypalPayoutWebhookPayload,
} from './payout-webhook-correlation';
import {
  applyPlanTransition,
  applySubscriptionTransition,
} from './subscription-evidence-application';
import {
  isSubscriptionPaymentEvidenceEvent,
  isSubscriptionWebhookProviderRefreshEvent,
  mapPlanWebhookEventToStatus,
  mapSubscriptionWebhookEventToStatus,
  parseSubscriptionResourceStateTimestamp,
} from './subscription-transition-policy';
import type { ReconciliationProviderLookup } from './checkout-provider-port';
import { subscriptionBillingFieldsFromProviderSnapshot } from './subscription-provider-snapshot-fields';
import { assertSubscriptionProviderPlanSnapshotConsistent } from './subscription-provider-plan-consistency';
import { resolveProviderFailure } from './resolve-provider-failure';
import { sanitizeOperationalErrorMessage } from './public-error-sanitizer';
import {
  isSellerOnboardingWebhookEvent,
  mapSellerWebhookEventToConsentHint,
} from './seller-transition-policy';
import { deriveSellerConnectionStatus } from './seller-transition-policy';
import {
  deriveMarketplaceOrderStatusFromUnits,
  mapMarketplaceCaptureWebhookToUnitStatus,
} from './marketplace-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import { sha256Payload } from './persistence/memory-payment-reliability-store';
import {
  classifyWebhookEvidenceResume,
  isConsumerDeliveryComplete,
  isVerificationUnavailable,
} from './webhook-evidence-resume';

export type ReceiveWebhookInput = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: 'sandbox' | 'live';
  rawBody: string;
  providerEventId: string;
  verify: () => Promise<VerifyWebhookResult>;
};

export type WebhookSubscriptionProviderLookup = Pick<
  ReconciliationProviderLookup,
  'getSubscription'
>;

export class WebhookProcessingService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly subscriptionProviderLookup?: WebhookSubscriptionProviderLookup,
  ) {}

  async receiveWebhook(input: ReceiveWebhookInput): Promise<WebhookReceiptResponse> {
    const existing = await this.store.findEvidenceByProviderEvent(
      input.providerCode,
      input.accountRef,
      input.environment,
      input.providerEventId,
    );
    if (existing) {
      return this.handleExistingEvidence(existing, input);
    }

    let evidence: ProviderEvidenceRecord;
    try {
      evidence = await this.insertWebhookEvidence(input);
    } catch (error) {
      if (
        error instanceof PaymentReliabilityError &&
        error.code === PAYMENT_RELIABILITY_ERROR.EVIDENCE_DUPLICATE
      ) {
        const raced = await this.store.findEvidenceByProviderEvent(
          input.providerCode,
          input.accountRef,
          input.environment,
          input.providerEventId,
        );
        if (!raced) {
          throw error;
        }
        return this.handleExistingEvidence(raced, input);
      }
      throw this.toSanitizedPersistenceFailure(error);
    }

    return this.driveWebhookLifecycle(evidence, input);
  }

  async reprocessStoredWebhookEvidence(evidenceId: string): Promise<WebhookReceiptResponse> {
    const evidence = await this.store.findEvidenceById(evidenceId);
    if (!evidence) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        `Evidence ${evidenceId} was not found`,
      );
    }
    assertVerifiedEvidence(evidence.verificationStatus);
    if (evidence.processingStatus === 'processed') {
      return this.toReceipt(evidence, isConsumerDeliveryComplete(evidence));
    }
    return this.processVerifiedWebhookEvidence(evidence, evidence.rawPayload);
  }

  private handleExistingEvidence(
    evidence: ProviderEvidenceRecord,
    input: ReceiveWebhookInput,
  ): Promise<WebhookReceiptResponse> {
    const action = classifyWebhookEvidenceResume(evidence);
    if (action === 'ack_duplicate') {
      return Promise.resolve(this.toReceipt(evidence, true));
    }
    if (action === 'terminal_rejected') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
        evidence.errorMessage ?? 'Webhook verification was rejected',
      );
    }
    return this.driveWebhookLifecycle(evidence, input);
  }

  private async driveWebhookLifecycle(
    evidence: ProviderEvidenceRecord,
    input: ReceiveWebhookInput,
  ): Promise<WebhookReceiptResponse> {
    if (
      evidence.verificationStatus === 'pending' ||
      (evidence.verificationStatus === 'rejected' &&
        evidence.errorCode === PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE)
    ) {
      evidence = await this.runWebhookVerification(evidence, input);
    }

    if (evidence.verificationStatus !== 'verified') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
        evidence.errorMessage ?? 'Webhook is not verified',
      );
    }

    if (evidence.processingStatus === 'processed') {
      if (!isConsumerDeliveryComplete(evidence)) {
        return this.toReceipt(evidence, false);
      }
      return this.toReceipt(evidence, true);
    }

    return this.processVerifiedWebhookEvidence(evidence, input.rawBody);
  }

  private async runWebhookVerification(
    evidence: ProviderEvidenceRecord,
    input: ReceiveWebhookInput,
  ): Promise<ProviderEvidenceRecord> {
    const verification = await input.verify();
    if (!verification.verified) {
      if (isVerificationUnavailable(verification)) {
        const pending = await this.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          verificationStatus: 'pending',
          processingStatus: 'pending',
          errorCode: PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE,
          errorMessage: verification.unavailableReason ?? 'Webhook verification unavailable',
          processedAt: null,
        });
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE,
          pending.errorMessage ?? 'Webhook verification unavailable',
        );
      }

      const rejected = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        verificationStatus: 'rejected',
        processingStatus: 'failed',
        errorCode: PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
        errorMessage: verification.unavailableReason ?? 'Webhook verification failed',
        processedAt: new Date().toISOString(),
      });
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.VERIFICATION_REJECTED,
        rejected.errorMessage ?? 'Webhook verification failed',
      );
    }

    return this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      verificationStatus: 'verified',
      eventType: verification.eventType ?? evidence.eventType,
      resourceId: verification.resourceId ?? evidence.resourceId,
      errorCode: null,
      errorMessage: null,
    });
  }

  private async insertWebhookEvidence(input: ReceiveWebhookInput): Promise<ProviderEvidenceRecord> {
    let parsedEventType: string | null = null;
    let parsedResourceId: string | null = null;
    try {
      const parsed = JSON.parse(input.rawBody) as {
        event_type?: string;
        resource?: { id?: string };
      };
      parsedEventType = parsed.event_type ?? null;
      parsedResourceId = parsed.resource?.id ?? null;
    } catch {
      parsedEventType = null;
      parsedResourceId = null;
    }

    return this.store.insertEvidence({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      evidenceKind: 'webhook',
      providerEventId: input.providerEventId,
      rawPayload: input.rawBody,
      payloadSha256: sha256Payload(input.rawBody),
      eventType: parsedEventType,
      resourceId: parsedResourceId,
    });
  }

  private async processVerifiedWebhookEvidence(
    evidence: ProviderEvidenceRecord,
    rawBody: string,
  ): Promise<WebhookReceiptResponse> {
    let current = evidence;

    const payoutFinancialStatus = current.eventType
      ? mapPayoutWebhookEventToFinancialStatus(current.eventType)
      : null;
    if (payoutFinancialStatus) {
      return this.processPayoutWebhook(current, payoutFinancialStatus, rawBody);
    }

    const subscriptionRefreshOnly =
      current.eventType != null && isSubscriptionWebhookProviderRefreshEvent(current.eventType);
    const subscriptionStatus = current.eventType
      ? mapSubscriptionWebhookEventToStatus(current.eventType)
      : null;
    if (subscriptionStatus || subscriptionRefreshOnly) {
      return this.processSubscriptionWebhook(current, subscriptionStatus, rawBody);
    }

    const planStatus = current.eventType ? mapPlanWebhookEventToStatus(current.eventType) : null;
    if (planStatus) {
      return this.processPlanWebhook(current, planStatus);
    }

    if (current.eventType && isSubscriptionPaymentEvidenceEvent(current.eventType)) {
      return this.processSubscriptionPaymentEvidence({
        ...current,
        rawPayload: rawBody,
      });
    }

    if (current.eventType && isSellerOnboardingWebhookEvent(current.eventType)) {
      return this.processSellerOnboardingWebhook(current, rawBody);
    }

    const marketplaceReceipt = await this.tryProcessMarketplaceWebhook(current);
    if (marketplaceReceipt) {
      return marketplaceReceipt;
    }

    const mappedStatus = current.eventType
      ? mapCheckoutWebhookEventToStatus(current.eventType)
      : null;
    if (!mappedStatus) {
      current = await this.store.updateEvidence({
        evidenceId: current.evidenceId,
        processingStatus: 'unsupported',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(current, false);
    }

    const operation = await this.findCorrelatedOperation(current);

    if (!operation) {
      current = await this.store.updateEvidence({
        evidenceId: current.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(current, false);
    }

    assertVerifiedEvidence(current.verificationStatus);
    assertTransitionAllowed(operation.status, mappedStatus);

    await this.store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus: mappedStatus,
      providerReferenceId: current.resourceId,
      evidenceId: current.evidenceId,
      reason: `Webhook ${current.eventType ?? 'unknown'}`,
    });

    current = await this.markFinancialProcessed(current.evidenceId, {
      relatedOperationId: operation.operationId,
    });

    return this.toReceipt(current, false);
  }

  private async markFinancialProcessed(
    evidenceId: string,
    input: {
      relatedOperationId?: string | null;
      resourceId?: string | null;
    } = {},
  ): Promise<ProviderEvidenceRecord> {
    const existing = await this.store.findEvidenceById(evidenceId);
    const deliveryFields =
      existing?.consumerDeliveryStatus === undefined && existing?.processingStatus !== 'processed'
        ? {
            consumerDeliveryStatus: 'pending' as const,
            consumerDeliveryAttempts: existing?.consumerDeliveryAttempts ?? 0,
          }
        : {};
    return this.store.updateEvidence({
      evidenceId,
      relatedOperationId: input.relatedOperationId,
      resourceId: input.resourceId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
      ...deliveryFields,
    });
  }

  async reprocessVerifiedUnmatchedPayoutEvidence(input: {
    evidenceIds?: string[];
    limit?: number;
  }): Promise<{ processed: number; skipped: number; unmatched: number }> {
    const counters = { processed: 0, skipped: 0, unmatched: 0 };
    const candidates = await this.listVerifiedUnmatchedPayoutEvidence(input);

    for (const row of candidates) {
      if (row.processingStatus === 'processed') {
        counters.skipped += 1;
        continue;
      }
      const payoutFinancialStatus = row.eventType
        ? mapPayoutWebhookEventToFinancialStatus(row.eventType)
        : null;
      if (!payoutFinancialStatus) {
        counters.skipped += 1;
        continue;
      }

      const receipt = await this.processPayoutWebhook(row, payoutFinancialStatus, row.rawPayload);
      if (receipt.processingStatus === 'processed') {
        counters.processed += 1;
      } else if (receipt.processingStatus === 'unmatched') {
        counters.unmatched += 1;
      } else {
        counters.skipped += 1;
      }
    }

    return counters;
  }

  private async listVerifiedUnmatchedPayoutEvidence(input: {
    evidenceIds?: string[];
    limit?: number;
  }) {
    if (input.evidenceIds?.length) {
      const rows = await Promise.all(
        input.evidenceIds.map((evidenceId) => this.store.findEvidenceById(evidenceId)),
      );
      return rows.flatMap((row) => {
        if (!row) {
          return [];
        }
        if (row.verificationStatus !== 'verified') {
          return [];
        }
        if (!row.eventType || !mapPayoutWebhookEventToFinancialStatus(row.eventType)) {
          return [];
        }
        return [row];
      });
    }

    const limit = input.limit ?? 25;
    return (await this.store.listReconciliationCandidates(limit)).filter(
      (row) =>
        row.verificationStatus === 'verified' &&
        row.processingStatus === 'unmatched' &&
        Boolean(row.eventType && mapPayoutWebhookEventToFinancialStatus(row.eventType)),
    );
  }

  private async processPayoutWebhook(
    evidence: {
      evidenceId: string;
      providerCode: string;
      accountRef: string;
      applicationRef: string;
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
      verificationStatus: WebhookReceiptResponse['verificationStatus'];
      processingStatus: WebhookReceiptResponse['processingStatus'];
    },
    payoutFinancialStatus: NonNullable<ReturnType<typeof mapPayoutWebhookEventToFinancialStatus>>,
    rawPayload: string,
  ): Promise<WebhookReceiptResponse> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const correlation = await correlatePayoutOperation(this.store, {
      providerCode: evidence.providerCode,
      accountRef: evidence.accountRef,
      applicationRef: evidence.applicationRef,
      environment: evidence.environment,
      eventType: evidence.eventType,
      resourceId: evidence.resourceId,
      rawPayload,
    });

    if (!correlation) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    const { operation, parsed } = correlation;
    const providerFields = buildPayoutTransitionProviderFields(
      operation,
      parsed,
      payoutFinancialStatus,
    );

    const transition = await applyPayoutTransition(this.store, {
      operation,
      payoutStatus: payoutFinancialStatus,
      evidenceId: evidence.evidenceId,
      reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
      ...providerFields,
    });

    if (parsed.payoutScope === 'payout_item' && transition.operation.parentOperationId) {
      const batch = await this.store.findOperationById(transition.operation.parentOperationId);
      if (batch) {
        await refreshPayoutBatchAggregate(
          this.store,
          batch,
          evidence.evidenceId,
          'Derived payout batch aggregate after item webhook',
        );
      }
    }

    const canonicalResourceId =
      parsed.canonicalResourceId ??
      parsePaypalPayoutWebhookPayload(rawPayload, evidence.eventType)?.canonicalResourceId ??
      evidence.resourceId;

    const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: transition.operation.operationId,
      resourceId: canonicalResourceId,
    });

    return this.toReceipt(updatedEvidence, false);
  }

  private async tryProcessMarketplaceWebhook(evidence: {
    evidenceId: string;
    providerCode: string;
    accountRef: string;
    applicationRef: string;
    environment: 'sandbox' | 'live';
    eventType: string | null;
    resourceId: string | null;
    verificationStatus: WebhookReceiptResponse['verificationStatus'];
    processingStatus: WebhookReceiptResponse['processingStatus'];
  }): Promise<WebhookReceiptResponse | null> {
    const resourceId = evidence.resourceId;
    if (!resourceId || !evidence.eventType) {
      return null;
    }

    const captureUnitStatus = mapMarketplaceCaptureWebhookToUnitStatus(evidence.eventType);
    if (captureUnitStatus) {
      const unit = await this.store.findMarketplacePurchaseUnitByCaptureId(resourceId);
      if (!unit) {
        return null;
      }
      const checkout = await this.store.findOperationById(unit.operationId);
      if (!checkout || checkout.kind !== 'marketplace_checkout') {
        return null;
      }

      assertVerifiedEvidence(evidence.verificationStatus);
      if (!(unit.unitStatus === 'captured' && captureUnitStatus !== 'captured')) {
        await this.store.updateMarketplacePurchaseUnit({
          unitId: unit.unitId,
          expectedVersion: unit.version,
          unitStatus: captureUnitStatus,
          providerCaptureId: resourceId,
        });
      }

      const units = await this.store.listMarketplacePurchaseUnits(checkout.operationId);
      const aggregateStatus = deriveMarketplaceOrderStatusFromUnits(
        units.map((row) => row.unitStatus),
      );
      const parentNext = this.mapMarketplaceAggregateToOperationStatus(aggregateStatus);
      if (parentNext && parentNext !== checkout.status) {
        try {
          assertTransitionAllowed(checkout.status, parentNext);
          await this.store.transitionOperation({
            operationId: checkout.operationId,
            expectedVersion: checkout.version,
            nextStatus: parentNext,
            providerReferenceId: checkout.providerOrderId ?? checkout.providerReferenceId,
            evidenceId: evidence.evidenceId,
            reason: `Marketplace webhook ${evidence.eventType}`,
          });
        } catch {
          // Preserve sibling captures when aggregate transition is not yet allowed.
        }
      }

      const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
        relatedOperationId: checkout.operationId,
      });
      return this.toReceipt(updatedEvidence, false);
    }

    if (
      evidence.eventType === 'CHECKOUT.ORDER.APPROVED' ||
      evidence.eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED'
    ) {
      const checkout = await this.store.findOperationByProviderOrderId(
        evidence.providerCode,
        evidence.accountRef,
        evidence.environment,
        resourceId,
      );
      if (!checkout || checkout.kind !== 'marketplace_checkout') {
        return null;
      }

      assertVerifiedEvidence(evidence.verificationStatus);
      if (evidence.eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') {
        const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
          relatedOperationId: checkout.operationId,
        });
        return this.toReceipt(updatedEvidence, false);
      }

      if (checkout.status !== 'submitted') {
        try {
          assertTransitionAllowed(checkout.status, 'submitted');
          await this.store.transitionOperation({
            operationId: checkout.operationId,
            expectedVersion: checkout.version,
            nextStatus: 'submitted',
            providerReferenceId: resourceId,
            evidenceId: evidence.evidenceId,
            reason: `Marketplace webhook ${evidence.eventType}`,
          });
        } catch {
          // Approval must not force fulfillment.
        }
      }

      const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
        relatedOperationId: checkout.operationId,
      });
      return this.toReceipt(updatedEvidence, false);
    }

    return null;
  }

  private mapMarketplaceAggregateToOperationStatus(
    aggregateStatus: ReturnType<typeof deriveMarketplaceOrderStatusFromUnits>,
  ): PaymentOperationStatus | null {
    switch (aggregateStatus) {
      case 'captured':
        return 'succeeded';
      case 'failed':
        return 'failed';
      case 'partially_captured':
        return 'unknown';
      default:
        return null;
    }
  }

  private async findCorrelatedOperation(evidence: {
    providerCode: string;
    accountRef: string;
    environment: 'sandbox' | 'live';
    eventType: string | null;
    resourceId: string | null;
  }) {
    const resourceId = evidence.resourceId;
    if (!resourceId) {
      return null;
    }

    const kind = evidence.eventType ? mapWebhookEventToOperationKind(evidence.eventType) : null;
    if (kind === 'checkout') {
      return this.store.findOperationByProviderOrderId(
        evidence.providerCode,
        evidence.accountRef,
        evidence.environment,
        resourceId,
      );
    }
    if (kind === 'capture') {
      return (
        (await this.store.findOperationByProviderCaptureId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        )) ??
        (await this.store.findOperationByProviderOrderId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        ))
      );
    }
    if (kind === 'refund') {
      return (
        (await this.store.findOperationByProviderRefundId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        )) ??
        (await this.store.findOperationByProviderCaptureId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        ))
      );
    }

    return this.store.findOperationByProviderReference(
      evidence.providerCode,
      evidence.accountRef,
      evidence.environment,
      resourceId,
    );
  }

  private async processSubscriptionWebhook(
    evidence: {
      evidenceId: string;
      providerCode: string;
      accountRef: string;
      applicationRef: string;
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
      verificationStatus: WebhookReceiptResponse['verificationStatus'];
      processingStatus: WebhookReceiptResponse['processingStatus'];
    },
    eventSubscriptionStatus: SubscriptionStatus | null,
    rawPayload: string,
  ): Promise<WebhookReceiptResponse> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const operation = await this.findCorrelatedSubscriptionOperation(evidence);
    if (!operation) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    if (!this.subscriptionProviderLookup) {
      if (!eventSubscriptionStatus) {
        const updated = await this.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          processingStatus: 'unsupported',
          processedAt: new Date().toISOString(),
        });
        return this.toReceipt(updated, false);
      }

      await applySubscriptionTransition(this.store, {
        operation,
        subscriptionStatus: eventSubscriptionStatus,
        evidenceId: evidence.evidenceId,
        reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
        providerReferenceId: evidence.resourceId,
        providerSubscriptionId: evidence.resourceId,
        providerStateTimestamp: parseSubscriptionResourceStateTimestamp(rawPayload),
        applySource: 'webhook',
      });

      const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
        relatedOperationId: operation.operationId,
      });

      return this.toReceipt(updatedEvidence, false);
    }

    const providerSubscriptionId =
      operation.providerSubscriptionId ?? evidence.resourceId ?? undefined;
    if (!providerSubscriptionId) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    let lookup;
    try {
      lookup = await this.subscriptionProviderLookup.getSubscription({
        providerCode: evidence.providerCode,
        accountRef: evidence.accountRef,
        applicationRef: evidence.applicationRef,
        environment: evidence.environment,
        providerSubscriptionId,
      });
    } catch (error) {
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operation.operationId,
        error,
      );
    }

    const recognizedProviderStatus =
      lookup.subscriptionStatus && lookup.subscriptionStatus !== 'unknown'
        ? lookup.subscriptionStatus
        : null;
    const subscriptionStatus =
      recognizedProviderStatus ??
      eventSubscriptionStatus ??
      operation.subscriptionStatus ??
      'approval_pending';

    if (subscriptionStatus === 'unknown') {
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operation.operationId,
        new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          'Subscription provider state remains unknown',
        ),
      );
    }

    try {
      assertSubscriptionProviderPlanSnapshotConsistent(operation, lookup);
    } catch (error) {
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operation.operationId,
        error,
      );
    }

    const providerStateTimestamp =
      lookup.providerSubscriptionStateAt != null &&
      lookup.providerSubscriptionStateAt.trim().length > 0
        ? lookup.providerSubscriptionStateAt
        : null;

    await applySubscriptionTransition(this.store, {
      operation,
      subscriptionStatus,
      evidenceId: evidence.evidenceId,
      reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
      providerReferenceId: evidence.resourceId,
      providerSubscriptionId: evidence.resourceId,
      providerStateTimestamp,
      applySource: 'webhook',
      ...subscriptionBillingFieldsFromProviderSnapshot(lookup),
    });

    const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: operation.operationId,
    });

    return this.toReceipt(updatedEvidence, false);
  }

  private async leaveSubscriptionWebhookRefreshRecoverable(
    evidenceId: string,
    operationId: string,
    error: unknown,
  ): Promise<WebhookReceiptResponse> {
    const failure = resolveProviderFailure(error);
    const updated = await this.store.updateEvidence({
      evidenceId,
      relatedOperationId: operationId,
      processingStatus: 'pending',
      errorCode: failure.code,
      errorMessage: failure.message,
      processedAt: null,
    });
    return this.toReceipt(updated, false);
  }

  private async processPlanWebhook(
    evidence: {
      evidenceId: string;
      providerCode: string;
      accountRef: string;
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
      verificationStatus: WebhookReceiptResponse['verificationStatus'];
      processingStatus: WebhookReceiptResponse['processingStatus'];
    },
    planStatus: NonNullable<ReturnType<typeof mapPlanWebhookEventToStatus>>,
  ): Promise<WebhookReceiptResponse> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const operation = await this.findCorrelatedPlanOperation(evidence);
    if (!operation) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    await applyPlanTransition(this.store, {
      operation,
      planStatus,
      evidenceId: evidence.evidenceId,
      reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
      providerReferenceId: evidence.resourceId,
      providerPlanId: evidence.resourceId,
    });

    const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: operation.operationId,
    });

    return this.toReceipt(updatedEvidence, false);
  }

  private async processSubscriptionPaymentEvidence(evidence: {
    evidenceId: string;
    providerCode: string;
    accountRef: string;
    environment: 'sandbox' | 'live';
    eventType: string | null;
    resourceId: string | null;
    verificationStatus: WebhookReceiptResponse['verificationStatus'];
    processingStatus: WebhookReceiptResponse['processingStatus'];
    rawPayload?: string;
  }): Promise<WebhookReceiptResponse> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const billingAgreementId = this.resolveBillingAgreementId(evidence);
    const operation = billingAgreementId
      ? await this.store.findOperationByProviderSubscriptionId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          billingAgreementId,
        )
      : null;

    if (!operation) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: operation.operationId,
    });

    return this.toReceipt(updatedEvidence, false);
  }

  private resolveBillingAgreementId(evidence: {
    resourceId: string | null;
    rawPayload?: string;
  }): string | null {
    if (evidence.rawPayload) {
      try {
        const parsed = JSON.parse(evidence.rawPayload) as {
          resource?: { billing_agreement_id?: string; id?: string };
        };
        if (parsed.resource?.billing_agreement_id) {
          return parsed.resource.billing_agreement_id;
        }
      } catch {
        // fall through
      }
    }
    return evidence.resourceId;
  }

  private async findCorrelatedSubscriptionOperation(evidence: {
    providerCode: string;
    accountRef: string;
    environment: 'sandbox' | 'live';
    resourceId: string | null;
  }) {
    const resourceId = evidence.resourceId;
    if (!resourceId) {
      return null;
    }
    return this.store.findOperationByProviderSubscriptionId(
      evidence.providerCode,
      evidence.accountRef,
      evidence.environment,
      resourceId,
    );
  }

  private async findCorrelatedPlanOperation(evidence: {
    providerCode: string;
    accountRef: string;
    environment: 'sandbox' | 'live';
    resourceId: string | null;
  }) {
    const resourceId = evidence.resourceId;
    if (!resourceId) {
      return null;
    }
    return this.store.findOperationByProviderPlanId(
      evidence.providerCode,
      evidence.accountRef,
      evidence.environment,
      resourceId,
    );
  }

  private async processSellerOnboardingWebhook(
    evidence: {
      evidenceId: string;
      providerCode: string;
      accountRef: string;
      applicationRef: string;
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
    },
    rawBody: string,
  ): Promise<WebhookReceiptResponse> {
    let merchantId: string | null = evidence.resourceId;
    let trackingId: string | null = null;
    try {
      const parsed = JSON.parse(rawBody) as {
        resource?: { merchant_id?: string; tracking_id?: string; merchant_id_in_paypal?: string };
      };
      merchantId =
        parsed.resource?.merchant_id ?? parsed.resource?.merchant_id_in_paypal ?? merchantId;
      trackingId = parsed.resource?.tracking_id ?? null;
    } catch {
      merchantId = evidence.resourceId;
    }

    const connection =
      (merchantId
        ? await this.store.findSellerConnectionByMerchantId(
            evidence.applicationRef,
            evidence.providerCode,
            evidence.accountRef,
            evidence.environment,
            merchantId,
          )
        : null) ??
      (trackingId
        ? await this.store.findSellerConnectionByTrackingId(
            evidence.applicationRef,
            evidence.providerCode,
            evidence.accountRef,
            evidence.environment,
            trackingId,
          )
        : null);

    if (!connection) {
      const unmatched = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(unmatched, false);
    }

    const consentHint = evidence.eventType
      ? mapSellerWebhookEventToConsentHint(evidence.eventType)
      : null;
    if (consentHint === 'revoked') {
      const readinessReady = false;
      await this.store.updateSellerConnection({
        connectionId: connection.connectionId,
        expectedVersion: connection.version,
        providerMerchantId: merchantId ?? connection.providerMerchantId,
        consentStatus: 'revoked',
        readinessReady,
        onboardingCompleted: false,
        connectionStatus: deriveSellerConnectionStatus({
          consentStatus: 'revoked',
          readinessReady,
          restricted: connection.restricted,
          providerMerchantId: merchantId ?? connection.providerMerchantId,
        }),
        readinessReasons: ['seller consent was revoked'],
      });
    } else if (
      consentHint === 'granted' &&
      connection.consentStatus !== 'revoked' &&
      evidence.eventType !== 'MERCHANT.ONBOARDING.COMPLETED'
    ) {
      await this.store.updateSellerConnection({
        connectionId: connection.connectionId,
        expectedVersion: connection.version,
        providerMerchantId: merchantId ?? connection.providerMerchantId,
        consentStatus: 'granted',
        connectionStatus: deriveSellerConnectionStatus({
          consentStatus: 'granted',
          readinessReady: false,
          restricted: connection.restricted,
          providerMerchantId: merchantId ?? connection.providerMerchantId,
        }),
      });
    } else if (merchantId && !connection.providerMerchantId) {
      await this.store.updateSellerConnection({
        connectionId: connection.connectionId,
        expectedVersion: connection.version,
        providerMerchantId: merchantId,
        connectionStatus: 'onboarding_pending',
      });
    }

    const processed = await this.markFinancialProcessed(evidence.evidenceId);
    return this.toReceipt(processed, false);
  }

  private toReceipt(
    evidence: {
      evidenceId: string;
      verificationStatus: WebhookReceiptResponse['verificationStatus'];
      processingStatus: WebhookReceiptResponse['processingStatus'];
    },
    duplicate: boolean,
  ): WebhookReceiptResponse {
    return {
      evidenceId: evidence.evidenceId,
      duplicate,
      verificationStatus: evidence.verificationStatus,
      processingStatus: evidence.processingStatus,
    };
  }

  private toSanitizedPersistenceFailure(error: unknown): PaymentReliabilityError {
    if (error instanceof PaymentReliabilityError) {
      return error;
    }
    return new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
      sanitizeOperationalErrorMessage(error, 'Webhook evidence persistence failed'),
    );
  }
}
