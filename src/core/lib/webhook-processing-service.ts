import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperationStatus,
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
  mapPlanWebhookEventToStatus,
  mapSubscriptionWebhookEventToStatus,
} from './subscription-transition-policy';
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

export type ReceiveWebhookInput = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: 'sandbox' | 'live';
  rawBody: string;
  providerEventId: string;
  verify: () => Promise<VerifyWebhookResult>;
};

export class WebhookProcessingService {
  constructor(private readonly store: PaymentReliabilityStore) {}

  async receiveWebhook(input: ReceiveWebhookInput): Promise<WebhookReceiptResponse> {
    const existing = await this.store.findEvidenceByProviderEvent(
      input.providerCode,
      input.accountRef,
      input.environment,
      input.providerEventId,
    );
    if (existing) {
      return {
        evidenceId: existing.evidenceId,
        duplicate: true,
        verificationStatus: existing.verificationStatus,
        processingStatus: existing.processingStatus,
      };
    }

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

    const inserted = await this.store.insertEvidence({
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

    const verification = await input.verify();
    if (!verification.verified) {
      const rejected = await this.store.updateEvidence({
        evidenceId: inserted.evidenceId,
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

    let evidence = await this.store.updateEvidence({
      evidenceId: inserted.evidenceId,
      verificationStatus: 'verified',
      eventType: verification.eventType ?? parsedEventType,
      resourceId: verification.resourceId ?? parsedResourceId,
    });

    const payoutFinancialStatus = evidence.eventType
      ? mapPayoutWebhookEventToFinancialStatus(evidence.eventType)
      : null;
    if (payoutFinancialStatus) {
      return this.processPayoutWebhook(evidence, payoutFinancialStatus, input.rawBody);
    }

    const subscriptionStatus = evidence.eventType
      ? mapSubscriptionWebhookEventToStatus(evidence.eventType)
      : null;
    if (subscriptionStatus) {
      return this.processSubscriptionWebhook(evidence, subscriptionStatus);
    }

    const planStatus = evidence.eventType ? mapPlanWebhookEventToStatus(evidence.eventType) : null;
    if (planStatus) {
      return this.processPlanWebhook(evidence, planStatus);
    }

    if (evidence.eventType && isSubscriptionPaymentEvidenceEvent(evidence.eventType)) {
      return this.processSubscriptionPaymentEvidence({
        ...evidence,
        rawPayload: input.rawBody,
      });
    }

    if (evidence.eventType && isSellerOnboardingWebhookEvent(evidence.eventType)) {
      return this.processSellerOnboardingWebhook(evidence, input.rawBody);
    }

    const marketplaceReceipt = await this.tryProcessMarketplaceWebhook(evidence);
    if (marketplaceReceipt) {
      return marketplaceReceipt;
    }

    const mappedStatus = evidence.eventType
      ? mapCheckoutWebhookEventToStatus(evidence.eventType)
      : null;
    if (!mappedStatus) {
      evidence = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unsupported',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(evidence, false);
    }

    const operation = await this.findCorrelatedOperation(evidence);

    if (!operation) {
      evidence = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(evidence, false);
    }

    assertVerifiedEvidence(evidence.verificationStatus);
    assertTransitionAllowed(operation.status, mappedStatus);

    await this.store.transitionOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextStatus: mappedStatus,
      providerReferenceId: evidence.resourceId,
      evidenceId: evidence.evidenceId,
      reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
    });

    evidence = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: operation.operationId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
    });

    return this.toReceipt(evidence, false);
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

    const updatedEvidence = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: transition.operation.operationId,
      resourceId: canonicalResourceId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
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

      const updatedEvidence = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        relatedOperationId: checkout.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
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
        const updatedEvidence = await this.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          relatedOperationId: checkout.operationId,
          processingStatus: 'processed',
          processedAt: new Date().toISOString(),
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

      const updatedEvidence = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        relatedOperationId: checkout.operationId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
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
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
      verificationStatus: WebhookReceiptResponse['verificationStatus'];
      processingStatus: WebhookReceiptResponse['processingStatus'];
    },
    subscriptionStatus: NonNullable<ReturnType<typeof mapSubscriptionWebhookEventToStatus>>,
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

    await applySubscriptionTransition(this.store, {
      operation,
      subscriptionStatus,
      evidenceId: evidence.evidenceId,
      reason: `Webhook ${evidence.eventType ?? 'unknown'}`,
      providerReferenceId: evidence.resourceId,
      providerSubscriptionId: evidence.resourceId,
    });

    const updatedEvidence = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: operation.operationId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
    });

    return this.toReceipt(updatedEvidence, false);
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

    const updatedEvidence = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: operation.operationId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
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

    const updatedEvidence = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      relatedOperationId: operation.operationId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
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

    const processed = await this.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
    });
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
}
