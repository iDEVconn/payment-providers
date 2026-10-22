import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type PaymentOperationStatus,
  type PaypalWebhookTransmissionHeaders,
  type ProviderEvidenceRecord,
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
  HELD_EFFECTS_OVERFLOW,
  SUBSCRIPTION_EFFECTS_HOOK_FAILED,
  SUBSCRIPTION_EFFECTS_HOOK_MISSING,
  SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP,
  applyPlanTransition,
  applySubscriptionEvents,
  deliverSubscriptionEffects,
  normalizeSubscriptionEvidencePayload,
  readHeldSubscriptionEffects,
  resolveExpectedSubscriptionPayment,
  subscriptionEventFromProviderSnapshot,
  type ApplySubscriptionEventsResult,
  type SubscriptionEffectsHooks,
  type SubscriptionEventStep,
} from './subscription-evidence-application';
import {
  isSubscriptionPaymentEvidenceEvent,
  mapPlanWebhookEventToStatus,
} from './subscription-transition-policy';
import { isSubscriptionEvidenceEvent } from './subscription-evidence-events';
import type { ReconciliationProviderLookup } from './checkout-provider-port';
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
import type {
  CheckoutStore,
  MarketplaceStore,
  PayoutStore,
  SellerStore,
  SubscriptionStore,
} from './persistence/payment-reliability-store';
import {
  assertStoreCapabilitiesComplete,
  hasCheckoutStore,
  hasMarketplaceStore,
  hasPayoutStore,
  hasSellerStore,
} from './persistence/store-capabilities';
import { sha256Payload } from './sha256-payload';
import { deriveProviderEventId } from '../../subscription-core/lib/normalize-paypal-subscription-event';
import type {
  NormalizedSubscriptionEvent,
  SubscriptionEffect,
} from '../../subscription-core/lib/subscription-core-types';
import { parseProviderTimestamp } from '../../subscription-core/lib/subscription-status-rules';
import { PaymentConfigurationError } from './payment-configuration-error';
import { CLEARED_RETRY_STATE, hasRetryState } from './retry-backoff';
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
  /**
   * Provider event id. Derived from the body `id` when omitted; a value that differs from the body
   * `id` is rejected, so a captured body cannot be replayed under a new id.
   */
  providerEventId?: string;
  /**
   * Transmission headers. When passed, every header must be set; `transmissionTime` is checked only
   * when the host enables `maxTransmissionAgeMs`. Pass the same object the `verify` closure sends.
   */
  headers?: PaypalWebhookTransmissionHeaders;
  verify: () => Promise<VerifyWebhookResult>;
};

/** Default intake cap for a webhook body (256 KiB of UTF-8). */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 262_144;
/** Allowed future skew of `transmissionTime` once `maxTransmissionAgeMs` turns the check on (5 min). */
export const DEFAULT_WEBHOOK_MAX_TRANSMISSION_FUTURE_MS = 300_000;

/** Checks that run before any evidence is stored or any provider verify call is made. */
export type WebhookIntakeOptions = {
  /** Largest accepted body in UTF-8 bytes. Default `DEFAULT_WEBHOOK_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /**
   * Opt-in freshness check: reject an event id never seen before whose `headers.transmissionTime`
   * is older than this. Default `null` (off). PayPal retries a failed delivery for about 3 days,
   * so use at least 72 h (259200000). A stored event is always resumed, whatever its time.
   */
  maxTransmissionAgeMs?: number | null;
  /**
   * Largest accepted future skew of `transmissionTime`. Only used when `maxTransmissionAgeMs` is set.
   * Default `DEFAULT_WEBHOOK_MAX_TRANSMISSION_FUTURE_MS`.
   */
  maxTransmissionFutureMs?: number;
  /**
   * @deprecated Use `maxTransmissionAgeMs` and `maxTransmissionFutureMs`. Sets both directions to
   * the same window unless they are given; `null` keeps the check off.
   */
  maxTransmissionSkewMs?: number | null;
  /** Reject requests without `headers`. Default false: headers are checked whenever they are passed. */
  requireTransmissionHeaders?: boolean;
  /** Clock for the freshness check (tests). */
  now?: () => Date;
};

type TransmissionWindow = { maxAgeMs: number; maxFutureMs: number };

function requirePositiveMs(
  options: WebhookIntakeOptions,
  key: 'maxBodyBytes' | 'maxTransmissionAgeMs' | 'maxTransmissionFutureMs' | 'maxTransmissionSkewMs',
  integer: boolean,
): void {
  const value = options[key];
  const nullable = key === 'maxTransmissionAgeMs' || key === 'maxTransmissionSkewMs';
  if (value === undefined || (value === null && nullable)) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new PaymentConfigurationError(
      `Webhook intake option ${key} must be a finite number greater than 0${integer ? ' (integer)' : ''}`,
      [key],
    );
  }
}

/** Validates the options at construction: an invalid limit must never silently disable a check. */
function resolveTransmissionWindow(options: WebhookIntakeOptions): TransmissionWindow | null {
  requirePositiveMs(options, 'maxBodyBytes', true);
  requirePositiveMs(options, 'maxTransmissionAgeMs', false);
  requirePositiveMs(options, 'maxTransmissionFutureMs', false);
  requirePositiveMs(options, 'maxTransmissionSkewMs', false);
  const legacySkew = options.maxTransmissionSkewMs ?? null;
  const maxAgeMs =
    options.maxTransmissionAgeMs !== undefined ? options.maxTransmissionAgeMs : legacySkew;
  if (maxAgeMs === null) {
    return null;
  }
  const maxFutureMs =
    options.maxTransmissionFutureMs ??
    (options.maxTransmissionAgeMs === undefined && legacySkew !== null
      ? legacySkew
      : DEFAULT_WEBHOOK_MAX_TRANSMISSION_FUTURE_MS);
  return { maxAgeMs, maxFutureMs };
}

function isWithinTransmissionWindow(
  transmissionTime: string,
  now: Date,
  window: TransmissionWindow,
): boolean {
  const parsed = parseProviderTimestamp(transmissionTime);
  if (!parsed) {
    return false;
  }
  const ageMs = now.getTime() - Date.parse(parsed);
  return ageMs <= window.maxAgeMs && -ageMs <= window.maxFutureMs;
}

type AcceptedWebhookInput = ReceiveWebhookInput & { providerEventId: string };

const TRANSMISSION_HEADER_FIELDS = [
  'transmissionId',
  'transmissionTime',
  'certUrl',
  'authAlgo',
  'transmissionSig',
] as const satisfies ReadonlyArray<keyof PaypalWebhookTransmissionHeaders>;

function rejectAtIntake(message: string): PaymentReliabilityError {
  return new PaymentReliabilityError(PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST, message);
}

function utf8ByteLengthExceeds(text: string, maxBytes: number): boolean {
  // Every UTF-16 code unit encodes to at least one UTF-8 byte: skip encoding oversized strings.
  if (text.length > maxBytes) {
    return true;
  }
  return new TextEncoder().encode(text).byteLength > maxBytes;
}

/**
 * A known provider event id was received again with a different body (`WEBHOOK_PAYLOAD_MISMATCH`).
 * Rejected before any processing: the stored body is the one that was (or will be) verified and
 * applied. Permanent for this delivery: answer non-2xx and check that the raw body reaches
 * `receiveWebhook` unchanged (no proxy re-encoding); resending the altered body never succeeds.
 */
export class WebhookEventPayloadMismatchError extends PaymentReliabilityError {
  constructor() {
    super(
      PAYMENT_RELIABILITY_ERROR.WEBHOOK_PAYLOAD_MISMATCH,
      'Webhook body differs from the stored body of the same provider event id',
    );
    this.name = 'WebhookEventPayloadMismatchError';
  }
}

export type WebhookSubscriptionProviderLookup = Pick<
  ReconciliationProviderLookup,
  'getSubscription'
>;

/** Evidence codes whose row waits for effects held on its subscription operation. */
const HELD_EFFECTS_DELIVERY_CODES: ReadonlySet<string> = new Set([
  SUBSCRIPTION_EFFECTS_HOOK_FAILED,
  SUBSCRIPTION_EFFECTS_HOOK_MISSING,
]);

function undeliveredEffectsMessage(code: string): string {
  if (code === HELD_EFFECTS_OVERFLOW) {
    return 'Not applied yet: the subscription holds the maximum of undelivered effect batches';
  }
  if (code === SUBSCRIPTION_EFFECTS_HOOK_MISSING) {
    return 'Held subscription effects need an onSubscriptionEffects hook on this service';
  }
  return 'Subscription effects hook failed; the effects are delivered again on retry';
}

function isUnreadableSubscriptionState(error: unknown): boolean {
  return (
    error instanceof PaymentReliabilityError &&
    (error.code === PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_UNREADABLE ||
      error.code === PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_VERSION_UNSUPPORTED)
  );
}

function isSubscriptionPaymentEvent(event: NormalizedSubscriptionEvent): boolean {
  return event.resourceType === 'sale' || isSubscriptionPaymentEvidenceEvent(event.eventType);
}

/** Billing fields the snapshot lacks are taken from the webhook body. */
function snapshotWithWebhookFallbacks(
  snapshot: NormalizedSubscriptionEvent,
  webhook: NormalizedSubscriptionEvent,
): NormalizedSubscriptionEvent {
  return {
    ...snapshot,
    providerPlanId: snapshot.providerPlanId ?? webhook.providerPlanId,
    nextBillingTime: snapshot.nextBillingTime ?? webhook.nextBillingTime,
    startTime: snapshot.startTime ?? webhook.startTime,
    lastPayment: snapshot.lastPayment ?? webhook.lastPayment,
    failedPaymentsCount: snapshot.failedPaymentsCount ?? webhook.failedPaymentsCount,
    outstandingBalance: snapshot.outstandingBalance ?? webhook.outstandingBalance,
  };
}

/**
 * A `SubscriptionStore` is enough. Checkout, payout, seller and marketplace events are applied only
 * when the store has that capability; otherwise their evidence is recorded as `unsupported`. A
 * capability with only some of its methods throws `PaymentConfigurationError` (at construction,
 * or when the event arrives if the store changed since).
 */
export type WebhookProcessingStore = SubscriptionStore &
  Partial<CheckoutStore & PayoutStore & SellerStore & MarketplaceStore>;

export class WebhookProcessingService {
  private readonly transmissionWindow: TransmissionWindow | null;

  constructor(
    private readonly store: WebhookProcessingStore,
    private readonly subscriptionProviderLookup?: WebhookSubscriptionProviderLookup,
    private readonly intakeOptions: WebhookIntakeOptions = {},
    /** Optional host hooks; `onSubscriptionEffects` gets the reducer's effects after each save. */
    private readonly hooks: SubscriptionEffectsHooks = {},
  ) {
    assertStoreCapabilitiesComplete(store);
    this.transmissionWindow = resolveTransmissionWindow(intakeOptions);
  }

  async receiveWebhook(webhook: ReceiveWebhookInput): Promise<WebhookReceiptResponse> {
    const input = this.acceptWebhookAtIntake(webhook);
    const existing = await this.store.findEvidenceByProviderEvent(
      input.providerCode,
      input.accountRef,
      input.environment,
      input.providerEventId,
    );
    if (existing) {
      return this.handleExistingEvidence(existing, input);
    }

    this.assertFreshTransmission(input);
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

  /**
   * Cheap checks before anything is stored or sent to the provider: required headers, body size
   * and the event id. Throws `INVALID_REQUEST`; messages never echo values.
   */
  private acceptWebhookAtIntake(input: ReceiveWebhookInput): AcceptedWebhookInput {
    const options = this.intakeOptions;
    if (input.headers) {
      const headers = input.headers;
      const missing = TRANSMISSION_HEADER_FIELDS.filter((field) => {
        const value: unknown = headers[field];
        return typeof value !== 'string' || value.trim().length === 0;
      });
      if (missing.length > 0) {
        throw rejectAtIntake(`Webhook transmission header is missing: ${missing.join(', ')}`);
      }
    } else if (options.requireTransmissionHeaders) {
      throw rejectAtIntake('Webhook transmission headers are required');
    }

    if (typeof input.rawBody !== 'string') {
      throw rejectAtIntake('Webhook body must be the raw request text');
    }
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
    if (utf8ByteLengthExceeds(input.rawBody, maxBodyBytes)) {
      throw rejectAtIntake(`Webhook body is too large (limit ${maxBodyBytes} bytes)`);
    }

    const bodyEventId = deriveProviderEventId(input.rawBody);
    const hostEventId = input.providerEventId?.trim() ? input.providerEventId : undefined;
    if (hostEventId !== undefined && bodyEventId !== null && hostEventId !== bodyEventId) {
      throw rejectAtIntake('Webhook providerEventId does not match the event body id');
    }
    const providerEventId = hostEventId ?? bodyEventId;
    if (!providerEventId) {
      throw rejectAtIntake('Webhook event id is missing');
    }
    return { ...input, providerEventId };
  }

  /**
   * Opt-in freshness check for an event id seen for the first time (after the evidence lookup,
   * before the insert): a stored pending event is resumed even when PayPal redelivers it with its
   * original, old transmission time.
   */
  private assertFreshTransmission(input: AcceptedWebhookInput): void {
    const window = this.transmissionWindow;
    if (!window || !input.headers) {
      return;
    }
    const now = this.intakeOptions.now?.() ?? new Date();
    if (!isWithinTransmissionWindow(input.headers.transmissionTime, now, window)) {
      throw rejectAtIntake('Webhook transmission time is invalid or outside the allowed window');
    }
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
    input: AcceptedWebhookInput,
  ): Promise<WebhookReceiptResponse> {
    if (sha256Payload(input.rawBody) !== evidence.payloadSha256) {
      throw new WebhookEventPayloadMismatchError();
    }
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
    input: AcceptedWebhookInput,
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

  private async insertWebhookEvidence(
    input: AcceptedWebhookInput,
  ): Promise<ProviderEvidenceRecord> {
    let parsedEventType: string | null = null;
    let parsedResourceId: string | null = null;
    try {
      // Stored before verification: only string values, never whatever an unauthenticated body sends.
      const parsed = JSON.parse(input.rawBody) as {
        event_type?: unknown;
        resource?: { id?: unknown } | null;
      } | null;
      parsedEventType = typeof parsed?.event_type === 'string' ? parsed.event_type : null;
      parsedResourceId = typeof parsed?.resource?.id === 'string' ? parsed.resource.id : null;
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
      if (!hasPayoutStore(this.store)) {
        return this.markUnsupported(current.evidenceId);
      }
      return this.processPayoutWebhook(this.store, current, payoutFinancialStatus, rawBody);
    }

    if (current.eventType && isSubscriptionEvidenceEvent(current.eventType)) {
      return this.processSubscriptionEvidence(current, rawBody);
    }
    if (
      current.relatedOperationId &&
      current.errorCode != null &&
      HELD_EFFECTS_DELIVERY_CODES.has(current.errorCode)
    ) {
      return this.redeliverHeldSubscriptionEffects(current, current.relatedOperationId);
    }

    const planStatus = current.eventType ? mapPlanWebhookEventToStatus(current.eventType) : null;
    if (planStatus) {
      return this.processPlanWebhook(current, planStatus);
    }

    if (current.eventType && isSellerOnboardingWebhookEvent(current.eventType)) {
      if (!hasSellerStore(this.store)) {
        return this.markUnsupported(current.evidenceId);
      }
      return this.processSellerOnboardingWebhook(this.store, current, rawBody);
    }

    if (hasMarketplaceStore(this.store) && hasCheckoutStore(this.store)) {
      const marketplaceReceipt = await this.tryProcessMarketplaceWebhook(this.store, current);
      if (marketplaceReceipt) {
        return marketplaceReceipt;
      }
    }

    const mappedStatus = current.eventType
      ? mapCheckoutWebhookEventToStatus(current.eventType)
      : null;
    if (!mappedStatus || !hasCheckoutStore(this.store)) {
      return this.markUnsupported(current.evidenceId);
    }

    const operation = await this.findCorrelatedOperation(this.store, current);

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

  private async markUnsupported(evidenceId: string): Promise<WebhookReceiptResponse> {
    const updated = await this.store.updateEvidence({
      evidenceId,
      processingStatus: 'unsupported',
      processedAt: new Date().toISOString(),
    });
    return this.toReceipt(updated, false);
  }

  private async markFinancialProcessed(
    evidenceId: string,
    input: {
      relatedOperationId?: string | null;
      resourceId?: string | null;
      /** Clear the error of an earlier failed attempt (subscription evidence). */
      clearError?: boolean;
    } = {},
  ): Promise<ProviderEvidenceRecord> {
    const existing = await this.store.findEvidenceById(evidenceId);
    const deliveryFields =
      // A SQL store may read the unset column back as `null`: same meaning as `undefined`.
      existing?.consumerDeliveryStatus == null && existing?.processingStatus !== 'processed'
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
      ...(input.clearError ? { errorCode: null, errorMessage: null } : {}),
      ...deliveryFields,
      // Processed: a backoff or `gave_up` of earlier attempts no longer applies.
      ...(existing && hasRetryState(existing) ? CLEARED_RETRY_STATE : {}),
    });
  }

  async reprocessVerifiedUnmatchedPayoutEvidence(input: {
    evidenceIds?: string[];
    limit?: number;
  }): Promise<{ processed: number; skipped: number; unmatched: number }> {
    const counters = { processed: 0, skipped: 0, unmatched: 0 };
    const store = this.store;
    if (!hasPayoutStore(store)) {
      return counters;
    }
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

      const receipt = await this.processPayoutWebhook(
        store,
        row,
        payoutFinancialStatus,
        row.rawPayload,
      );
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
    store: WebhookProcessingStore & PayoutStore,
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

    const correlation = await correlatePayoutOperation(store, {
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

    const transition = await applyPayoutTransition(store, {
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
          store,
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

  private async tryProcessMarketplaceWebhook(
    store: WebhookProcessingStore & MarketplaceStore & CheckoutStore,
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
  ): Promise<WebhookReceiptResponse | null> {
    const resourceId = evidence.resourceId;
    if (!resourceId || !evidence.eventType) {
      return null;
    }

    const captureUnitStatus = mapMarketplaceCaptureWebhookToUnitStatus(evidence.eventType);
    if (captureUnitStatus) {
      const unit = await store.findMarketplacePurchaseUnitByCaptureId(resourceId);
      if (!unit) {
        return null;
      }
      const checkout = await store.findOperationById(unit.operationId);
      if (!checkout || checkout.kind !== 'marketplace_checkout') {
        return null;
      }

      assertVerifiedEvidence(evidence.verificationStatus);
      if (!(unit.unitStatus === 'captured' && captureUnitStatus !== 'captured')) {
        await store.updateMarketplacePurchaseUnit({
          unitId: unit.unitId,
          expectedVersion: unit.version,
          unitStatus: captureUnitStatus,
          providerCaptureId: resourceId,
        });
      }

      const units = await store.listMarketplacePurchaseUnits(checkout.operationId);
      const aggregateStatus = deriveMarketplaceOrderStatusFromUnits(
        units.map((row) => row.unitStatus),
      );
      const parentNext = this.mapMarketplaceAggregateToOperationStatus(aggregateStatus);
      if (parentNext && parentNext !== checkout.status) {
        try {
          assertTransitionAllowed(checkout.status, parentNext);
          await store.transitionOperation({
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
      const checkout = await store.findOperationByProviderOrderId(
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
          await store.transitionOperation({
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

  private async findCorrelatedOperation(
    store: WebhookProcessingStore & CheckoutStore,
    evidence: {
      providerCode: string;
      accountRef: string;
      environment: 'sandbox' | 'live';
      eventType: string | null;
      resourceId: string | null;
    },
  ) {
    const resourceId = evidence.resourceId;
    if (!resourceId) {
      return null;
    }

    const kind = evidence.eventType ? mapWebhookEventToOperationKind(evidence.eventType) : null;
    if (kind === 'checkout') {
      return store.findOperationByProviderOrderId(
        evidence.providerCode,
        evidence.accountRef,
        evidence.environment,
        resourceId,
      );
    }
    if (kind === 'capture') {
      return (
        (await store.findOperationByProviderCaptureId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        )) ??
        (await store.findOperationByProviderOrderId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        ))
      );
    }
    if (kind === 'refund') {
      return (
        (await store.findOperationByProviderRefundId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        )) ??
        (await store.findOperationByProviderCaptureId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          resourceId,
        ))
      );
    }

    return store.findOperationByProviderReference(
      evidence.providerCode,
      evidence.accountRef,
      evidence.environment,
      resourceId,
    );
  }

  /**
   * Subscription and subscription-payment events (`BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.*`): the
   * stored body is normalised and reduced by the pure core, the result persisted, then the effects
   * go to the host hook. With a provider lookup, a status event is applied as the provider's
   * current snapshot (ordered by the snapshot's state time); payment events never need a lookup.
   */
  private async processSubscriptionEvidence(
    evidence: ProviderEvidenceRecord,
    rawPayload: string,
  ): Promise<WebhookReceiptResponse> {
    assertVerifiedEvidence(evidence.verificationStatus);

    const event = normalizeSubscriptionEvidencePayload(rawPayload, evidence.providerEventId);
    const operation = event
      ? await this.store.findOperationByProviderSubscriptionId(
          evidence.providerCode,
          evidence.accountRef,
          evidence.environment,
          event.providerSubscriptionId,
        )
      : null;
    if (!event || !operation) {
      const updated = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'unmatched',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(updated, false);
    }

    let step: SubscriptionEventStep;
    if (isSubscriptionPaymentEvent(event) || !this.subscriptionProviderLookup) {
      step = {
        event,
        options: {
          source: 'webhook',
          expectedPayment:
            event.resourceType === 'sale'
              ? await resolveExpectedSubscriptionPayment(this.store, operation)
              : null,
        },
      };
    } else {
      let lookup;
      try {
        lookup = await this.subscriptionProviderLookup.getSubscription({
          providerCode: evidence.providerCode,
          accountRef: evidence.accountRef,
          applicationRef: evidence.applicationRef,
          environment: evidence.environment,
          providerSubscriptionId: operation.providerSubscriptionId ?? event.providerSubscriptionId,
        });
      } catch (error) {
        return this.leaveSubscriptionWebhookRefreshRecoverable(
          evidence.evidenceId,
          operation.operationId,
          error,
        );
      }
      const snapshotEvent = snapshotWithWebhookFallbacks(
        subscriptionEventFromProviderSnapshot(
          operation.providerSubscriptionId ?? event.providerSubscriptionId,
          lookup,
          {
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            fallbackStatus: event.subscriptionStatus,
          },
        ),
        event,
      );
      if (!snapshotEvent.subscriptionStatus && operation.subscriptionStatus === 'unknown') {
        return this.leaveSubscriptionWebhookRefreshRecoverable(
          evidence.evidenceId,
          operation.operationId,
          new PaymentReliabilityError(
            PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
            'Subscription provider state remains unknown',
          ),
        );
      }
      // Ordered as a webhook by the snapshot's own state time, as the event body's time may be
      // older; at the same second with another status the snapshot wins (final review F4).
      step = {
        event: snapshotEvent,
        options: { source: 'webhook' },
        lookupOnEqualConflict: true,
      };
    }

    let applied: ApplySubscriptionEventsResult;
    try {
      applied = await applySubscriptionEvents(this.store, {
        operation,
        steps: [step],
        evidenceId: evidence.evidenceId,
        reason: `Webhook ${event.eventType}`,
        holdEffects: Boolean(this.hooks.onSubscriptionEffects),
      });
    } catch (error) {
      if (!isUnreadableSubscriptionState(error)) {
        throw error;
      }
      // Fail closed: nothing is applied until the stored state is repaired or the package upgraded.
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operation.operationId,
        error,
      );
    }
    const delivery = await deliverSubscriptionEffects(this.store, this.hooks, applied, {
      evidenceId: evidence.evidenceId,
      eventType: event.eventType,
      source: 'webhook',
    });

    if (applied.planMismatch) {
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operation.operationId,
        new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
          'Subscription event plan does not match the stored plan',
        ),
      );
    }
    if (!delivery.delivered) {
      return this.markSubscriptionEffectsUndelivered(
        evidence.evidenceId,
        operation.operationId,
        delivery.code,
      );
    }
    if (applied.equalTimestampConflict) {
      // Never `processed` silently: reconciliation's provider lookup settles the status.
      const conflicting = await this.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        relatedOperationId: operation.operationId,
        processingStatus: 'unmatched',
        errorCode: SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP,
        errorMessage: 'Status conflicts with the stored status at the same provider state time',
        processedAt: new Date().toISOString(),
      });
      return this.toReceipt(conflicting, false);
    }

    const updatedEvidence = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: operation.operationId,
      clearError: true,
    });
    return this.toReceipt(updatedEvidence, false);
  }

  /**
   * Evidence that is not a webhook event (a reconciliation lookup) whose state was saved but whose
   * hook failed: deliver the effects held on the subscription operation, then mark it processed.
   */
  private async redeliverHeldSubscriptionEffects(
    evidence: ProviderEvidenceRecord,
    operationId: string,
  ): Promise<WebhookReceiptResponse> {
    const operation = await this.store.findOperationById(operationId);
    let effects: SubscriptionEffect[] = [];
    try {
      effects = operation ? readHeldSubscriptionEffects(operation, evidence.evidenceId) : [];
    } catch (error) {
      if (!isUnreadableSubscriptionState(error)) {
        throw error;
      }
      return this.leaveSubscriptionWebhookRefreshRecoverable(
        evidence.evidenceId,
        operationId,
        error,
      );
    }
    if (operation && effects.length > 0) {
      const delivery = await deliverSubscriptionEffects(
        this.store,
        this.hooks,
        {
          operation,
          decision: 'applied',
          reason: null,
          planMismatch: false,
          effects,
          heldKey: evidence.evidenceId,
          planMismatchToNotify: null,
          heldOverflow: false,
          equalTimestampConflict: false,
        },
        {
          evidenceId: evidence.evidenceId,
          eventType: evidence.eventType ?? 'unknown',
          source: 'reconciliation',
        },
      );
      if (!delivery.delivered) {
        return this.markSubscriptionEffectsUndelivered(
          evidence.evidenceId,
          operationId,
          delivery.code,
        );
      }
    }
    const processed = await this.markFinancialProcessed(evidence.evidenceId, {
      relatedOperationId: operationId,
      clearError: true,
    });
    return this.toReceipt(processed, false);
  }

  /** The row stays `pending`: never `processed` while its effects were not delivered. */
  private async markSubscriptionEffectsUndelivered(
    evidenceId: string,
    operationId: string,
    code: string,
  ): Promise<WebhookReceiptResponse> {
    const updated = await this.store.updateEvidence({
      evidenceId,
      relatedOperationId: operationId,
      processingStatus: 'pending',
      errorCode: code,
      errorMessage: undeliveredEffectsMessage(code),
      processedAt: null,
    });
    return this.toReceipt(updated, false);
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
    store: WebhookProcessingStore & SellerStore,
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
        ? await store.findSellerConnectionByMerchantId(
            evidence.applicationRef,
            evidence.providerCode,
            evidence.accountRef,
            evidence.environment,
            merchantId,
          )
        : null) ??
      (trackingId
        ? await store.findSellerConnectionByTrackingId(
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
      await store.updateSellerConnection({
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
      await store.updateSellerConnection({
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
      await store.updateSellerConnection({
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
